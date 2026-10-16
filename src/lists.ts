import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';

export type ListId = 'OFAC_SDN' | 'OFAC_CONS' | 'EU' | 'UK' | 'UN';
export type EntityType = 'individual' | 'entity' | 'vessel' | 'aircraft' | 'unknown';

export interface Entry {
    list: ListId;
    id: string;
    type: EntityType;
    name: string;
    aliases: string[];
    programs: string[];
    countries: string[];
    dob: string[];
    listed_on: string | null;
    source_url: string;
}

export const LIST_META: Record<ListId, { name: string; authority: string; urls: string[]; page: string }> = {
    OFAC_SDN: {
        name: 'OFAC Specially Designated Nationals (SDN) List',
        authority: 'US Treasury, Office of Foreign Assets Control',
        urls: ['SDN.CSV', 'ALT.CSV', 'ADD.CSV'].map(
            (f) => `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/${f}`,
        ),
        page: 'https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists',
    },
    OFAC_CONS: {
        name: 'OFAC Consolidated (non-SDN) Sanctions List',
        authority: 'US Treasury, Office of Foreign Assets Control',
        urls: ['CONS_PRIM.CSV', 'CONS_ALT.CSV', 'CONS_ADD.CSV'].map(
            (f) => `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/${f}`,
        ),
        page: 'https://ofac.treasury.gov/consolidated-sanctions-list-non-sdn-lists',
    },
    EU: {
        name: 'EU Consolidated Financial Sanctions List',
        authority: 'European Commission (DG FISMA)',
        urls: [
            'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
        ],
        page: 'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions',
    },
    UK: {
        name: 'UK Sanctions List (incl. OFSI asset-freeze targets)',
        authority: 'UK FCDO / HM Treasury OFSI',
        urls: ['https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv'],
        page: 'https://www.gov.uk/government/publications/the-uk-sanctions-list',
    },
    UN: {
        name: 'UN Security Council Consolidated List',
        authority: 'United Nations Security Council',
        urls: ['https://scsanctions.un.org/resources/xml/en/consolidated.xml'],
        page: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list',
    },
};

const UA = 'FairqueryBot/1.0 (+https://apify.com/fairquery; sanctions screening)';

async function get(url: string, timeoutMs: number): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'user-agent': UA },
                redirect: 'follow',
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.ok) return res;
            last = new Error(`HTTP ${res.status}`);
            await res.body?.cancel().catch(() => undefined);
            if (res.status < 500 && res.status !== 429) break;
        } catch (e) {
            last = e;
        }
        await new Promise<void>((r) => {
            setTimeout(r, 1500 * (attempt + 1));
        });
    }
    throw new Error(`${url.split('?')[0]}: ${last instanceof Error ? last.message : String(last)}`);
}

const getText = async (url: string, t: number) => (await get(url, t)).text();
const nul = (s: string | undefined) => (s && s.trim() !== '-0-' ? s.trim() : '');
const uniq = (a: string[]) => [...new Set(a.map((x) => x.trim()).filter(Boolean))];

// ---------- OFAC (SDN / Consolidated CSV, no header) ----------
async function loadOfac(list: 'OFAC_SDN' | 'OFAC_CONS', t: number): Promise<Entry[]> {
    const [prim, alt, add] = await Promise.all(LIST_META[list].urls.map((u) => getText(u, t)));
    const opts = { relax_column_count: true, relax_quotes: true, skip_empty_lines: true } as const;
    const byId = new Map<string, Entry>();
    for (const r of parseSync(prim, opts) as string[][]) {
        const id = nul(r[0]);
        const name = nul(r[1]);
        if (!id || !name) continue;
        const typ = nul(r[2]).toLowerCase();
        const remarks = nul(r[11]);
        const dob = [...remarks.matchAll(/\bDOB ([^;.]+(?:\d{4}))/g)].map((m) => m[1].trim());
        const countries = [
            ...remarks.matchAll(/\b(?:nationality|citizen|Nationality of Registration) ([^;.()]+)/g),
        ].map((m) => m[1].trim());
        byId.set(id, {
            list,
            id,
            type:
                typ === 'individual'
                    ? 'individual'
                    : typ === 'vessel'
                      ? 'vessel'
                      : typ === 'aircraft'
                        ? 'aircraft'
                        : 'entity',
            name,
            aliases: [],
            programs: uniq(
                nul(r[3])
                    .replace(/^\[|\]$/g, '')
                    .split(/\]\s*\[/),
            ),
            countries: uniq(countries),
            dob: uniq(dob),
            listed_on: null,
            source_url: `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${id}`,
        });
    }
    for (const r of parseSync(alt, opts) as string[][]) {
        const e = byId.get(nul(r[0]));
        const n = nul(r[3]);
        if (e && n) e.aliases.push(n);
    }
    for (const r of parseSync(add, opts) as string[][]) {
        const e = byId.get(nul(r[0]));
        const c = nul(r[4]);
        if (e && c && !e.countries.includes(c)) e.countries.push(c);
    }
    return [...byId.values()];
}

// ---------- EU (CSV 1.1, ';' delimited, one row per name/address/birth/citizenship combination) ----------
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function loadEu(t: number): Promise<Entry[]> {
    const res = await get(LIST_META.EU.urls[0], t);
    const parser = Readable.fromWeb(res.body as unknown as WebReadableStream).pipe(
        parse({ delimiter: ';', relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true }),
    );
    let idx: Record<string, number> | null = null;
    const col = (r: string[], ...names: string[]) => {
        for (const n of names) {
            const i = idx![key(n)];
            if (i !== undefined && r[i]) return r[i].trim();
        }
        return '';
    };
    const byId = new Map<string, Entry>();
    for await (const r of parser as AsyncIterable<string[]>) {
        if (!idx) {
            idx = {};
            r.forEach((h, i) => {
                idx![key(h)] = i;
            });
            if (idx[key('Entity_LogicalId')] === undefined) throw new Error('EU CSV: unexpected header');
            continue;
        }
        const id = col(r, 'Entity_LogicalId');
        if (!id) continue;
        let e = byId.get(id);
        if (!e) {
            const code = col(r, 'Entity_SubjectType_ClassificationCode', 'Entity_SubjectType').toLowerCase();
            e = {
                list: 'EU',
                id: col(r, 'Entity_EU_ReferenceNumber') || id,
                type: code.startsWith('person') ? 'individual' : code ? 'entity' : 'unknown',
                name: '',
                aliases: [],
                programs: [],
                countries: [],
                dob: [],
                listed_on: col(r, 'Entity_DesignationDate') || null,
                source_url: LIST_META.EU.page,
            };
            byId.set(id, e);
        }
        const whole = col(r, 'NameAlias_WholeName');
        if (whole) {
            if (!e.name) e.name = whole;
            else if (whole !== e.name && !e.aliases.includes(whole)) e.aliases.push(whole);
        }
        const prog = col(r, 'Entity_Regulation_Programme');
        if (prog && !e.programs.includes(prog)) e.programs.push(prog);
        for (const c of [col(r, 'Citizenship_CountryDescription'), col(r, 'Address_CountryDescription')])
            if (c && c !== 'UNKNOWN' && !e.countries.includes(c)) e.countries.push(c);
        const bd = col(r, 'BirthDate_BirthDate') || col(r, 'BirthDate_Year');
        if (bd && !e.dob.includes(bd)) e.dob.push(bd);
    }
    return [...byId.values()].filter((e) => e.name);
}

// ---------- UK Sanctions List (CSV, first line "Report Date", one row per name variation) ----------
async function loadUk(t: number): Promise<Entry[]> {
    const res = await get(LIST_META.UK.urls[0], t);
    const parser = Readable.fromWeb(res.body as unknown as WebReadableStream).pipe(
        parse({ relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true }),
    );
    let idx: Record<string, number> | null = null;
    const col = (r: string[], n: string) => {
        const i = idx![key(n)];
        return i !== undefined && r[i] ? r[i].trim() : '';
    };
    const byId = new Map<string, Entry>();
    for await (const r of parser as AsyncIterable<string[]>) {
        if (!idx) {
            if (!r.some((c) => key(c) === 'uniqueid')) continue; // skip "Report Date" preamble
            idx = {};
            r.forEach((h, i) => {
                idx![key(h)] = i;
            });
            continue;
        }
        const id = col(r, 'Unique ID');
        if (!id) continue;
        const name = [
            col(r, 'Name 1'),
            col(r, 'Name 2'),
            col(r, 'Name 3'),
            col(r, 'Name 4'),
            col(r, 'Name 5'),
            col(r, 'Name 6'),
        ]
            .filter(Boolean)
            .join(' ');
        const nonLatin = col(r, 'Name non-latin script');
        let e = byId.get(id);
        if (!e) {
            const dt = col(r, 'Designation Type').toLowerCase();
            e = {
                list: 'UK',
                id,
                type: dt.startsWith('individual')
                    ? 'individual'
                    : dt.startsWith('ship')
                      ? 'vessel'
                      : dt
                        ? 'entity'
                        : 'unknown',
                name: '',
                aliases: [],
                programs: [],
                countries: [],
                dob: [],
                listed_on: col(r, 'Date Designated') || null,
                source_url: LIST_META.UK.page,
            };
            byId.set(id, e);
        }
        const primary = /^primary name$/i.test(col(r, 'Name type'));
        if (name) {
            if (primary && !e.name) e.name = name;
            else if (!e.aliases.includes(name) && name !== e.name) e.aliases.push(name);
        }
        if (nonLatin && !e.aliases.includes(nonLatin)) e.aliases.push(nonLatin);
        const reg = col(r, 'Regime Name');
        if (reg && !e.programs.includes(reg)) e.programs.push(reg);
        for (const c of [col(r, 'Nationality(/ies)'), col(r, 'Address Country'), col(r, 'Country of birth')].flatMap(
            (x) => x.split(/[,;]|\(\d+\)/),
        )) {
            const cc = c.trim();
            if (cc && !e.countries.includes(cc)) e.countries.push(cc);
        }
        for (const d of col(r, 'D.O.B')
            .split(/[,;]|\(\d+\)/)
            .map((x) => x.trim())
            .filter(Boolean))
            if (!e.dob.includes(d)) e.dob.push(d);
    }
    for (const e of byId.values()) if (!e.name && e.aliases.length) e.name = e.aliases.shift()!;
    return [...byId.values()].filter((e) => e.name);
}

// ---------- UN (XML) ----------
const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
type Obj = Record<string, unknown>;
const str = (x: unknown) => (x === undefined || x === null ? '' : String(x).trim());

async function loadUn(t: number): Promise<Entry[]> {
    const xml = await getText(LIST_META.UN.urls[0], t);
    const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml) as Obj;
    const root = (doc.CONSOLIDATED_LIST ?? {}) as Obj;
    const out: Entry[] = [];
    const conv = (n: Obj, kind: 'individual' | 'entity') => {
        const name = [n.FIRST_NAME, n.SECOND_NAME, n.THIRD_NAME, n.FOURTH_NAME].map(str).filter(Boolean).join(' ');
        if (!name) return;
        const aliases = arr((kind === 'individual' ? n.INDIVIDUAL_ALIAS : n.ENTITY_ALIAS) as Obj[])
            .map((a) => str(a.ALIAS_NAME))
            .filter(Boolean);
        const orig = str(n.NAME_ORIGINAL_SCRIPT);
        if (orig) aliases.push(orig);
        const countries = [
            ...arr((n.NATIONALITY as Obj | undefined)?.VALUE as string[]).map(str),
            ...arr((kind === 'individual' ? n.INDIVIDUAL_ADDRESS : n.ENTITY_ADDRESS) as Obj[]).map((a) =>
                str(a.COUNTRY),
            ),
        ];
        const dob = arr(n.INDIVIDUAL_DATE_OF_BIRTH as Obj[]).map(
            (d) => str(d.DATE) || str(d.YEAR) || [str(d.FROM_YEAR), str(d.TO_YEAR)].filter(Boolean).join('-'),
        );
        const ref = str(n.REFERENCE_NUMBER);
        out.push({
            list: 'UN',
            id: ref || str(n.DATAID),
            type: kind,
            name,
            aliases: uniq(aliases),
            programs: uniq([str(n.UN_LIST_TYPE)]),
            countries: uniq(countries),
            dob: uniq(dob),
            listed_on: str(n.LISTED_ON) || null,
            source_url: LIST_META.UN.page,
        });
    };
    for (const n of arr(((root.INDIVIDUALS ?? {}) as Obj).INDIVIDUAL as Obj[])) conv(n, 'individual');
    for (const n of arr(((root.ENTITIES ?? {}) as Obj).ENTITY as Obj[])) conv(n, 'entity');
    return out;
}

export async function loadList(id: ListId, timeoutMs: number): Promise<Entry[]> {
    switch (id) {
        case 'OFAC_SDN':
        case 'OFAC_CONS':
            return loadOfac(id, timeoutMs);
        case 'EU':
            return loadEu(timeoutMs);
        case 'UK':
            return loadUk(timeoutMs);
        case 'UN':
            return loadUn(timeoutMs);
        default:
            throw new Error(`Unknown list ${String(id)}`);
    }
}
