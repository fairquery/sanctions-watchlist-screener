#!/usr/bin/env node
/**
 * Fairquery stdio MCP server for Apify Actor fairquery/sanctions-watchlist-screener.
 * Tools: screen_names (runs the Actor, needs APIFY_TOKEN) and list_sources (free, local).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { callActorTool, ok, READ_ONLY_LOCAL, READ_ONLY_REMOTE } from './common.js';

const ACTOR_ID = 'fairquery~sanctions-watchlist-screener';
const DISCLAIMER =
    'Not a certified screening service. Automated fuzzy matching against public lists downloaded at run time; results can contain false positives and miss matches. Review every potential match manually and consult official sources and legal counsel before acting.';
const LISTS = ['OFAC_SDN', 'OFAC_CONS', 'EU', 'UK', 'UN'] as const;

const SOURCES = [
    { id: 'OFAC_SDN', name: 'OFAC Specially Designated Nationals (SDN) List', authority: 'US Treasury OFAC', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV' },
    { id: 'OFAC_CONS', name: 'OFAC Consolidated (non-SDN) Sanctions List', authority: 'US Treasury OFAC', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_PRIM.CSV' },
    { id: 'EU', name: 'EU Consolidated Financial Sanctions List', authority: 'European Commission (DG FISMA)', url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content' },
    { id: 'UK', name: 'UK Sanctions List (incl. OFSI asset-freeze targets)', authority: 'UK FCDO / HM Treasury OFSI', url: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv' },
    { id: 'UN', name: 'UN Security Council Consolidated List', authority: 'United Nations Security Council', url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml' },
];

const server = new McpServer({ name: 'fairquery-sanctions-screener', version: '1.0.2' });

server.registerTool(
    'screen_names',
    {
        title: 'Screen names against sanctions lists',
        description: [
            'WHAT: Fuzzy-match people or organisation names against the OFAC SDN, OFAC Consolidated (non-SDN), EU, UK and UN sanctions lists, downloaded fresh from the official sources on every run. Order-, case- and diacritics-insensitive; optional country and date-of-birth filters per name.',
            'WHEN TO USE: KYC/KYB onboarding, vendor or counterparty checks, bulk re-screening of customer lists. Put all names into one call (lists are downloaded once per run).',
            'WHEN NOT TO USE: to see which lists/authorities are covered or to cite sources, call list_sources (free). Not a PEP/adverse-media check, not a certified screening service.',
            'COST: paid. Runs Apify Actor fairquery/sanctions-watchlist-screener with your APIFY_TOKEN; pay-per-event "name-screened": $0.005 per name that gets a screening row, match or no match (nothing charged if no list could be downloaded; error rows free). 200 names ~ $1.00. List download takes ~10-40 s, then hundreds of names/s.',
            'RETURNS: {count, items}. type="screening" row per name: query, status (potential_match | no_match), best_score 0-100, match_count, matches[] (list, entry id, primary name, aliases, programs, countries, DOB, score, country_match, dob_match), lists_screened, lists_unavailable, min_score, screened_at, disclaimer; or type="error" rows (code, message).',
            'EXAMPLE: {"queries":[{"name":"Banco Nacional de Cuba","entityType":"entity"}],"minScore":90} -> one screening row, status potential_match with OFAC_SDN matches.',
            'PARAMETERS: names and/or queries: at least one is required although the schema marks both optional (neither -> a free INPUT_EMPTY error row); both may be combined and every entry is billed once ($0.005), so send all names in ONE call (lists download once per run). Use names for bare strings and queries when you have per-name country / dateOfBirth / entityType or want your own id echoed. Per query, dateOfBirth drops listed individuals whose recorded birth year differs by more than 1 year (entries without a DOB are kept); country only sets country_match (true/false/null) unless excludeNonMatchingCountry=true, which then drops matches whose listed countries exclude it (entries without country data are kept). entityType: a query\'s own value wins over the top-level one; "entity" means anything that is not an individual (organisations, vessels, aircraft), and list entries of unknown type always pass. lists: omit for all five; a list whose download fails is reported in lists_unavailable rather than failing the run. minScore: a candidate is returned only if its 0-100 name similarity is >= minScore; it does not change the price - 85 default, 90-95 for large batches with fewer false positives, 75-80 for transliterated names. maxMatchesPerName trims matches[] (best first) but match_count still counts all. ' + DISCLAIMER,
        ].join('\n'),
        inputSchema: {
            names: z
                .array(z.string().min(1))
                .optional()
                .describe('Optional if queries is given (at least one of the two is required). Plain person or organisation names (non-empty strings, any order/case/diacritics); $0.005 each. Example: ["Vladimir Putin","Acme Trading LLC"]'),
            queries: z
                .array(
                    z.object({
                        name: z.string().min(1).describe('Required. Person or organisation name to screen (non-empty), e.g. "Ali Khamenei"'),
                        id: z.string().optional().describe('Optional. Your own reference echoed in the output row, e.g. "cust-42"'),
                        country: z.string().optional().describe('Optional. ISO 3166-1 alpha-2 code ("IR") or English country name ("Iran"); adds country_match to each match (filters only with excludeNonMatchingCountry=true)'),
                        dateOfBirth: z.string().optional().describe('Optional. Format YYYY or YYYY-MM-DD, e.g. "1939" or "1939-04-19"; drops listed individuals whose birth year differs by more than 1 year'),
                        entityType: z.enum(['individual', 'entity', 'any']).optional().describe('Optional, one of "individual" | "entity" | "any"; default = top-level entityType. "entity" = organisations, vessels, aircraft'),
                    }),
                )
                .optional()
                .describe('Optional if names is given. {name, id?, country?, dateOfBirth?, entityType?} objects with per-name filters; $0.005 each. Example: [{"name":"Ali Khamenei","id":"cust-42","country":"IR","dateOfBirth":"1939","entityType":"individual"}]'),
            lists: z
                .array(z.enum(LISTS))
                .optional()
                .describe('Optional, default all five. Any subset of "OFAC_SDN" | "OFAC_CONS" | "EU" | "UK" | "UN" (ids from list_sources). Example: ["OFAC_SDN","EU"]'),
            minScore: z
                .number()
                .int()
                .min(60)
                .max(100)
                .optional()
                .describe('Optional integer 60-100, default 85. Minimum 0-100 fuzzy name-similarity score for a match. Use 90+ for fewer false positives, ~80 for more recall. Example: 90'),
            maxMatchesPerName: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe('Optional integer 1-100, default 10. Top matches returned per name (best first); match_count still reports the total. Example: 3'),
            entityType: z
                .enum(['individual', 'entity', 'any'])
                .optional()
                .describe('Optional, one of "any" | "individual" | "entity", default "any". Entity filter for all names; a query\'s own entityType wins. Example: "entity"'),
            excludeNonMatchingCountry: z
                .boolean()
                .optional()
                .describe('Optional boolean, default false. true removes matches whose listed countries do not include the query country (entries without country data are kept). No effect without queries[].country.'),
        },
        outputSchema: {
            items: z.array(z.record(z.unknown())).describe('Dataset rows: type=screening or type=error'),
            count: z.number().describe('Number of rows in items'),
        },
        annotations: { title: 'Screen names', ...READ_ONLY_REMOTE },
    },
    async (args) => callActorTool(ACTOR_ID, args),
);

server.registerTool(
    'list_sources',
    {
        title: 'List covered sanctions sources (free)',
        description: [
            'WHAT: Static list of the official sanctions lists screen_names checks (id, name, issuing authority, download URL), the 0-100 score scale and the legal disclaimer.',
            'WHEN TO USE: to choose the lists parameter for screen_names, cite sources in a report, or explain coverage.',
            'WHEN NOT TO USE: to screen a name - use screen_names. Does not download lists or report list freshness.',
            'COST: free; local, no network, no APIFY_TOKEN, deterministic. (screen_names costs $0.005 per name.)',
            'RETURNS: {sources:[{id,name,authority,url}], score_scale, disclaimer}.',
            'PARAMETERS: None: call with an empty object {}; the result is static and cannot be filtered. Its output feeds screen_names: each sources[].id (OFAC_SDN, OFAC_CONS, EU, UK, UN) is a valid value for its lists parameter, and score_scale explains how its minScore threshold is applied.',
            'EXAMPLE: {} -> {"sources":[{"id":"OFAC_SDN","authority":"US Treasury OFAC",...},...]}',
        ].join('\n'),
        inputSchema: {},
        outputSchema: {
            sources: z.array(z.object({ id: z.string(), name: z.string(), authority: z.string(), url: z.string() })).describe('Covered lists; id is the value for screen_names.lists'),
            score_scale: z.string().describe('How best_score is computed'),
            disclaimer: z.string().describe('Legal disclaimer to show with results'),
        },
        annotations: { title: 'List sources', ...READ_ONLY_LOCAL },
    },
    async () => ok({ sources: SOURCES, score_scale: '0-100 fuzzy name similarity (Jaro-Winkler token coverage, order- and diacritics-insensitive); default threshold 85', disclaimer: DISCLAIMER }),
);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
    console.error('fairquery-sanctions-screener MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
