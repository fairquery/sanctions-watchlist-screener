import { Actor, log } from 'apify';

import { countryMatches, countryTerms } from './countries.js';
import { Emitter } from './emitter.js';
import { type Entry, type EntityType, LIST_META, type ListId, loadList } from './lists.js';
import { NameIndex, nameScore, tokens, yearsOf } from './match.js';

const SCHEMA_VERSION = '1.0.0';
const EVENT = 'name-screened';
const ALL_LISTS: ListId[] = ['OFAC_SDN', 'OFAC_CONS', 'EU', 'UK', 'UN'];
export const DISCLAIMER =
    'Not a certified screening service. Automated fuzzy matching against public lists downloaded at run time; results can contain false positives and miss matches. Review every potential match manually and consult official sources and legal counsel before acting.';

interface Query {
    name?: string;
    id?: string;
    country?: string;
    dateOfBirth?: string;
    entityType?: 'individual' | 'entity' | 'any';
}
interface Input {
    names?: string[];
    queries?: Query[];
    lists?: ListId[];
    minScore?: number;
    maxMatchesPerName?: number;
    entityType?: 'individual' | 'entity' | 'any';
    country?: string;
    dobYearTolerance?: number;
    excludeNonMatchingCountry?: boolean;
    listDownloadTimeoutSecs?: number;
    maxNames?: number;
}

await Actor.init();
const startedAt = new Date().toISOString();
const emitter = new Emitter(50);
let aborting = false;
Actor.on('aborting', async () => {
    aborting = true;
    await emitter.flush();
});

const input = ((await Actor.getInput<Input>()) ?? {}) as Input;
const lists = (input.lists?.length ? input.lists : ALL_LISTS).filter((l) => ALL_LISTS.includes(l));
const minScore = input.minScore ?? 85;
const maxMatches = input.maxMatchesPerName ?? 10;
const tolerance = input.dobYearTolerance ?? 1;
const strictCountry = input.excludeNonMatchingCountry ?? false;
const timeoutMs = (input.listDownloadTimeoutSecs ?? 120) * 1000;
const maxNames = input.maxNames ?? 10000;

const queries: Query[] = [
    ...(input.names ?? [])
        .flatMap((n) => String(n).split(/\n+/))
        .map((n) => n.trim())
        .filter(Boolean)
        .map((name) => ({ name })),
    ...(input.queries ?? []).filter((q) => q && q.name && String(q.name).trim()),
];
const counters = { names_screened: 0, potential_matches: 0, names_with_matches: 0, errors: 0 };

if (!queries.length) {
    await pushError('INPUT_EMPTY', 'Provide at least one name in names or queries.', false, null);
    await finish({});
}
if (queries.length > maxNames) {
    await pushError(
        'MAX_NAMES_EXCEEDED',
        `${queries.length} names supplied; only the first ${maxNames} were screened.`,
        false,
        null,
    );
    queries.length = maxNames;
}

// ---- Download + parse lists once per run (in parallel), kept in memory only ----
log.info('Downloading sanctions lists', { lists });
const status: Record<string, { loaded: boolean; entries: number; ms: number; error?: string; source_urls: string[] }> =
    {};
const entries: Entry[] = [];
await Promise.all(
    lists.map(async (l) => {
        const t0 = Date.now();
        try {
            const e = await loadList(l, timeoutMs);
            for (const x of e) entries.push(x);
            status[l] = {
                loaded: true,
                entries: e.length,
                ms: Date.now() - t0,
                source_urls: LIST_META[l].urls.map((u) => u.split('?')[0]),
            };
        } catch (err) {
            status[l] = {
                loaded: false,
                entries: 0,
                ms: Date.now() - t0,
                error: err instanceof Error ? err.message : String(err),
                source_urls: LIST_META[l].urls.map((u) => u.split('?')[0]),
            };
            log.warning(`List ${l} unavailable: ${status[l].error}`);
        }
    }),
);
const loaded = lists.filter((l) => status[l]?.loaded);
const unavailable = lists.filter((l) => !status[l]?.loaded);
log.info('Lists loaded', Object.fromEntries(lists.map((l) => [l, status[l].entries])));

if (!loaded.length) {
    await pushError(
        'LISTS_UNAVAILABLE',
        `No sanctions list could be downloaded: ${unavailable.map((l) => `${l} (${status[l].error})`).join('; ')}`,
        true,
        null,
    );
    await finish(status);
}

const index = new NameIndex();
entries.forEach((e, i) => {
    index.add(e.name, i, false);
    for (const a of e.aliases) index.add(a, i, true);
});
log.info('Index built', { entries: entries.length, names: index.names.length });

for (const q of queries) {
    if (aborting || emitter.limitReached) break;
    const name = String(q.name).trim();
    const qTokens = tokens(name);
    const wantType = q.entityType ?? input.entityType ?? 'any';
    const cTerms = countryTerms(q.country ?? input.country ?? '');
    const qYears = q.dateOfBirth ? yearsOf(String(q.dateOfBirth)) : [];
    const best = new Map<number, { score: number; matched: string; alias: boolean }>();
    for (const id of index.candidates(qTokens)) {
        const n = index.names[id];
        const s = nameScore(qTokens, n.tokens);
        if (s < minScore) continue;
        const prev = best.get(n.entry);
        if (!prev || s > prev.score || (s === prev.score && prev.alias && !n.alias))
            best.set(n.entry, { score: s, matched: n.name, alias: n.alias });
    }
    const matches = [];
    for (const [ei, m] of best) {
        const e = entries[ei];
        if (wantType !== 'any' && !typeOk(e.type, wantType)) continue;
        const countryMatch = cTerms.length ? (e.countries.length ? countryMatches(cTerms, e.countries) : null) : null;
        if (cTerms.length && strictCountry && countryMatch === false) continue;
        const eYears = e.dob.flatMap(yearsOf);
        const dobMatch =
            qYears.length && eYears.length
                ? eYears.some((y) => qYears.some((qy) => Math.abs(y - qy) <= tolerance))
                : null;
        if (dobMatch === false) continue;
        matches.push({
            score: m.score,
            matched_name: m.matched,
            matched_on: m.alias ? 'alias' : 'primary',
            list: e.list,
            list_name: LIST_META[e.list].name,
            entry_id: e.id,
            entity_type: e.type,
            primary_name: e.name,
            aliases: e.aliases.slice(0, 15),
            programs: e.programs.slice(0, 10),
            countries: e.countries.slice(0, 10),
            dates_of_birth: e.dob.slice(0, 5),
            listed_on: e.listed_on,
            country_match: countryMatch,
            dob_match: dobMatch,
            source_url: e.source_url,
        });
    }
    matches.sort((a, b) => b.score - a.score || Number(b.country_match === true) - Number(a.country_match === true));
    const top = matches.slice(0, maxMatches);
    const row = {
        schema_version: SCHEMA_VERSION,
        type: 'screening',
        query: {
            name,
            id: q.id ?? null,
            country: q.country ?? input.country ?? null,
            date_of_birth: q.dateOfBirth ?? null,
            entity_type: wantType,
        },
        status: top.length ? 'potential_match' : 'no_match',
        best_score: top[0]?.score ?? null,
        match_count: matches.length,
        matches: top,
        lists_screened: loaded,
        lists_unavailable: unavailable,
        min_score: minScore,
        screened_at: new Date().toISOString(),
        disclaimer: DISCLAIMER,
    };
    await emitter.emit(row, EVENT);
    counters.names_screened += 1;
    counters.potential_matches += matches.length;
    if (top.length) counters.names_with_matches += 1;
}

await finish(status);

function typeOk(t: EntityType, want: 'individual' | 'entity'): boolean {
    if (t === 'unknown') return true;
    return want === 'individual' ? t === 'individual' : t !== 'individual';
}

async function pushError(code: string, message: string, retryable: boolean, name: string | null): Promise<void> {
    counters.errors += 1;
    await emitter.emit(
        {
            schema_version: SCHEMA_VERSION,
            type: 'error',
            code,
            message,
            retryable,
            query: name ? { name } : null,
            screened_at: new Date().toISOString(),
            disclaimer: DISCLAIMER,
        },
        null,
    );
}

async function finish(st: typeof status): Promise<never> {
    await emitter.flush();
    await Actor.setValue('RUN_SUMMARY', {
        schema_version: SCHEMA_VERSION,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        names_requested: queries.length,
        ...counters,
        lists: st,
        charged_events: emitter.charged,
        settings: {
            lists,
            minScore,
            maxMatchesPerName: maxMatches,
            dobYearTolerance: tolerance,
            excludeNonMatchingCountry: strictCountry,
            entityType: input.entityType ?? 'any',
        },
        disclaimer: DISCLAIMER,
    });
    await Actor.exit();
    return undefined as never;
}
