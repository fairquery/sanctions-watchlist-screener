/** Name normalisation and fuzzy matching (Jaro-Winkler + token coverage), no external deps. */

const ENTITY_STOPWORDS = new Set([
    'ltd',
    'llc',
    'inc',
    'co',
    'corp',
    'corporation',
    'company',
    'limited',
    'gmbh',
    'sa',
    'ag',
    'plc',
    'llp',
    'lp',
    'bv',
    'nv',
    'srl',
    'spa',
    'jsc',
    'ojsc',
    'pjsc',
    'cjsc',
    'ooo',
    'zao',
    'oao',
    'pao',
    'fze',
    'fzco',
    'fzc',
    'the',
    'of',
    'and',
    'group',
    'holding',
    'holdings',
    'sdn',
    'bhd',
    'pte',
    'pty',
    'kg',
    'as',
    'ab',
    'oy',
]);
const HONORIFICS = new Set([
    'mr',
    'mrs',
    'ms',
    'dr',
    'sheikh',
    'shaykh',
    'haji',
    'hajji',
    'mullah',
    'maulvi',
    'general',
    'colonel',
    'gen',
    'col',
    'prof',
]);

export function normalize(s: string): string {
    return s
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ß/g, 'ss')
        .replace(/[æÆ]/g, 'ae')
        .replace(/[øØ]/g, 'o')
        .replace(/[łŁ]/g, 'l')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fff]+/g, ' ')
        .trim();
}

export function tokens(s: string): string[] {
    const t = normalize(s).split(' ').filter(Boolean);
    const core = t.filter((x) => !ENTITY_STOPWORDS.has(x) && !HONORIFICS.has(x));
    return core.length ? core : t;
}

export function jaroWinkler(a: string, b: string): number {
    if (a === b) return 1;
    const la = a.length;
    const lb = b.length;
    if (!la || !lb) return 0;
    const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
    const ma = new Uint8Array(la);
    const mb = new Uint8Array(lb);
    let m = 0;
    for (let i = 0; i < la; i++) {
        const lo = Math.max(0, i - range);
        const hi = Math.min(i + range + 1, lb);
        for (let j = lo; j < hi; j++) {
            if (!mb[j] && a.charCodeAt(i) === b.charCodeAt(j)) {
                ma[i] = 1;
                mb[j] = 1;
                m++;
                break;
            }
        }
    }
    if (!m) return 0;
    let t = 0;
    let k = 0;
    for (let i = 0; i < la; i++) {
        if (!ma[i]) continue;
        while (!mb[k]) k++;
        if (a.charCodeAt(i) !== b.charCodeAt(k)) t++;
        k++;
    }
    const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
    let p = 0;
    while (p < Math.min(4, la, lb) && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    return jaro + p * 0.1 * (1 - jaro);
}

function coverage(from: string[], to: string[]): number {
    let sum = 0;
    let w = 0;
    for (const a of from) {
        let best = 0;
        for (const b of to) {
            let s: number;
            if (a === b) s = 1;
            else if (a.length <= 2 || b.length <= 2) s = (a.length === 1 || b.length === 1) && a[0] === b[0] ? 0.85 : 0;
            else {
                s = jaroWinkler(a, b);
                if (s < 0.8) s *= 0.5; // weak token similarity counts as little evidence
            }
            if (s > best) best = s;
        }
        const weight = Math.max(a.length, 2);
        sum += best * weight;
        w += weight;
    }
    return w ? sum / w : 0;
}

/** 0-100 similarity, order-insensitive, tolerant to typos/transliteration and extra middle names. */
export function nameScore(qTokens: string[], cTokens: string[]): number {
    if (!qTokens.length || !cTokens.length) return 0;
    const qc = coverage(qTokens, cTokens);
    const cq = coverage(cTokens, qTokens);
    let s = 0.75 * qc + 0.25 * cq;
    // a single-token query matching only one token of a long name is weak evidence
    if (qTokens.length === 1 && cTokens.length > 1) s = Math.min(s, 0.8 + 0.1 * qc);
    return Math.round(s * 1000) / 10;
}

export interface Indexed {
    tokens: string[];
    entry: number;
    alias: boolean;
    name: string;
}

/** Token inverted index with first-letter vocabulary buckets for fast candidate generation. */
export class NameIndex {
    readonly names: Indexed[] = [];
    private postings = new Map<string, number[]>();
    private vocabByFirst = new Map<string, string[]>();

    add(name: string, entry: number, alias: boolean): void {
        const t = tokens(name);
        if (!t.length) return;
        const id = this.names.length;
        this.names.push({ tokens: t, entry, alias, name });
        for (const tok of new Set(t)) {
            let p = this.postings.get(tok);
            if (!p) {
                p = [];
                this.postings.set(tok, p);
                const f = tok[0];
                (this.vocabByFirst.get(f) ?? this.vocabByFirst.set(f, []).get(f)!).push(tok);
            }
            p.push(id);
        }
    }

    candidates(qTokens: string[]): Set<number> {
        const out = new Set<number>();
        for (const q of qTokens) {
            if (q.length < 2) continue;
            for (const v of this.vocabByFirst.get(q[0]) ?? []) {
                if (v === q || (Math.abs(v.length - q.length) <= 3 && jaroWinkler(q, v) >= 0.88)) {
                    for (const id of this.postings.get(v)!) out.add(id);
                }
            }
        }
        return out;
    }
}

export function yearsOf(s: string): number[] {
    return [...s.matchAll(/\b(1[89]\d\d|20[0-2]\d)\b/g)].map((m) => Number(m[1]));
}
