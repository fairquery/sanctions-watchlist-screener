import { normalize } from './match.js';

const ALIASES: Record<string, string[]> = {
    RU: ['russia', 'russian federation'],
    IR: ['iran'],
    KP: ['north korea', 'korea north', 'democratic peoples republic of korea', 'dprk'],
    KR: ['south korea', 'korea south', 'republic of korea'],
    SY: ['syria', 'syrian arab republic'],
    VE: ['venezuela'],
    US: ['united states', 'usa'],
    GB: ['united kingdom', 'uk', 'great britain'],
    BY: ['belarus'],
    MM: ['burma', 'myanmar'],
    MD: ['moldova'],
    CD: ['democratic republic of the congo', 'congo democratic republic', 'drc'],
    CG: ['republic of the congo', 'congo republic'],
    CI: ['cote d ivoire', 'ivory coast'],
    LA: ['laos', 'lao'],
    TZ: ['tanzania'],
    BO: ['bolivia'],
    VN: ['vietnam', 'viet nam'],
    PS: ['palestine', 'palestinian', 'west bank', 'gaza'],
    TR: ['turkey', 'turkiye'],
    CZ: ['czech', 'czechia'],
    AE: ['united arab emirates', 'uae'],
    CN: ['china'],
    TW: ['taiwan'],
};

const display = new Intl.DisplayNames(['en'], { type: 'region' });

/** Normalised search terms for a country given as ISO-2 code or name. */
export function countryTerms(input: string): string[] {
    const s = input.trim();
    if (!s) return [];
    const terms = new Set<string>();
    if (/^[A-Za-z]{2}$/.test(s)) {
        const code = s.toUpperCase();
        try {
            const n = display.of(code);
            if (n && n !== code) terms.add(normalize(n));
        } catch {
            /* invalid code */
        }
        for (const a of ALIASES[code] ?? []) terms.add(a);
    } else {
        const n = normalize(s);
        terms.add(n);
        for (const list of Object.values(ALIASES)) if (list.includes(n)) for (const a of list) terms.add(a);
    }
    return [...terms].filter(Boolean);
}

export function countryMatches(terms: string[], entryCountries: string[]): boolean {
    for (const c of entryCountries) {
        const n = normalize(c);
        for (const t of terms) {
            if (n === t || ` ${n} `.includes(` ${t} `) || (n.length > 3 && ` ${t} `.includes(` ${n} `))) return true;
        }
    }
    return false;
}
