# Sanctions & Watchlist Screener (OFAC, EU, UK, UN)

**Fairquery** Apify Actor that screens **people and company names** against the main **public sanctions lists**, downloaded **fresh from the official sources on every run**: OFAC SDN and Consolidated (US), EU Consolidated Financial Sanctions, the UK Sanctions List (FCDO / OFSI), and the UN Security Council Consolidated List. Each name gets a `potential_match` / `no_match` status, a 0–100 fuzzy score, and the matching entries with aliases, programs, countries and dates of birth.

> **Not a certified screening service.** This is automated fuzzy matching against public lists. It can return false positives and can miss true matches (transliterations, very short names, lists that fail to download). Review every potential match manually against the official source, and get legal advice before acting on results. It does not replace a regulated KYC/AML provider.

## When to use this Actor (LLM / tool selection)

Use it when an agent or workflow needs to:

- Pre-screen a new customer, supplier, vendor or marketplace seller against sanctions lists (KYB / onboarding)
- Re-screen a counterparty list in bulk (thousands of names per run)
- Check whether a company or person is on OFAC, EU, UK or UN lists and see the program and listing details
- Add a sanctions check step to an export, payments or procurement workflow

## Lists and sources

| `lists` id | List | Source (downloaded each run) |
| --- | --- | --- |
| `OFAC_SDN` | OFAC Specially Designated Nationals | `sanctionslistservice.ofac.treas.gov` SDN.CSV + ALT.CSV + ADD.CSV |
| `OFAC_CONS` | OFAC Consolidated (non-SDN: SSI, NS-MBS, FSE, …) | CONS_PRIM / CONS_ALT / CONS_ADD.CSV |
| `EU` | EU Consolidated Financial Sanctions List | `webgate.ec.europa.eu/fsd/fsf` CSV 1.1 |
| `UK` | UK Sanctions List (incl. OFSI asset-freeze targets) | `sanctionslist.fcdo.gov.uk` CSV |
| `UN` | UN Security Council Consolidated List | `scsanctions.un.org` XML |

Lists are cached in memory for the run only and never stored. If a source is down, the run continues with the other lists and every row reports it in `lists_unavailable`; per-list entry counts, download times and errors are in `RUN_SUMMARY`.

## Matching

- Names are normalised (diacritics, case, punctuation, `&`, legal suffixes such as LLC/GmbH/JSC, honorifics) and compared **token by token** with Jaro-Winkler, so word order (`PUTIN, Vladimir`), extra middle names, and spelling variants (`Poutine`, `Usama/Osama`, `Gaddafi/Qadhafi`) still match.
- Every **alias** (a.k.a., f.k.a., non-Latin script names) is screened; `matched_on` tells you whether the hit was the primary name or an alias.
- Optional **country** (ISO-2 or name) adds `country_match`; `excludeNonMatchingCountry` drops mismatches.
- Optional **dateOfBirth** drops individuals whose listed birth years differ by more than `dobYearTolerance`; entries without a DOB are kept.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `names` | `string[]` | example | One name per line |
| `queries` | object[] | `[]` | `{name, id?, country?, dateOfBirth?, entityType?}` |
| `lists` | `string[]` | all five | `OFAC_SDN`, `OFAC_CONS`, `EU`, `UK`, `UN` |
| `minScore` | int | `85` | 60–100 |
| `maxMatchesPerName` | int | `10` | Top matches per name |
| `entityType` | `any` \| `individual` \| `entity` | `any` | |
| `country` | string | – | Default country for all names |
| `excludeNonMatchingCountry` | bool | `false` | |
| `dobYearTolerance` | int | `1` | |
| `listDownloadTimeoutSecs` | int | `120` | Per list file |
| `maxNames` | int | `10000` | Safety cap |

```json
{
  "names": ["Banco Nacional de Cuba", "Jane Example Smith"],
  "queries": [{ "name": "Ali Khamenei", "id": "cust-42", "country": "IR", "dateOfBirth": "1939" }]
}
```

## Output

```json
{
  "schema_version": "1.0.0", "type": "screening",
  "query": { "name": "Ali Khamenei", "id": "cust-42", "country": "IR", "date_of_birth": "1939", "entity_type": "any" },
  "status": "potential_match", "best_score": 92.5, "match_count": 1,
  "matches": [{
    "score": 92.5, "matched_name": "KHAMENEI, Ali Husseini", "matched_on": "primary",
    "list": "OFAC_SDN", "list_name": "OFAC Specially Designated Nationals (SDN) List", "entry_id": "…",
    "entity_type": "individual", "primary_name": "KHAMENEI, Ali Husseini", "aliases": ["…"], "programs": ["IRAN-EO13876"],
    "countries": ["Iran"], "dates_of_birth": ["19 Apr 1939"], "listed_on": null,
    "country_match": true, "dob_match": true, "source_url": "https://sanctionssearch.ofac.treas.gov/Details.aspx?id=…"
  }],
  "lists_screened": ["OFAC_SDN", "OFAC_CONS", "EU", "UK", "UN"], "lists_unavailable": [],
  "min_score": 85, "disclaimer": "Not a certified screening service. …"
}
```

Error rows (`type: "error"`, never charged): `INPUT_EMPTY`, `MAX_NAMES_EXCEEDED`, `LISTS_UNAVAILABLE` (no list could be downloaded).

## Pricing

Pay per event: **`name-screened`**, once per name that gets a screening row (match or no match). If no list can be downloaded, nothing is charged. See the pricing tab.

## Memory / runtime

Default **512 MB**. Downloading and indexing all five lists (about 30k entries, 100k+ names) takes roughly 10–40 s, depending on the government servers; after that screening runs at hundreds of names per second. Put all names into one run rather than one run per name.

## MCP / Apify tools

Call from agents via [Apify MCP](https://mcp.apify.com) with Actor `fairquery/sanctions-watchlist-screener`:

```json
{ "actor": "fairquery/sanctions-watchlist-screener", "input": { "names": ["Acme Trading LLC"] } }
```

## Local stdio MCP server

The [`mcp/`](./mcp) folder is a stdio MCP server (TypeScript, `@modelcontextprotocol/sdk`) with two tools, both with annotations and output schemas:

| Tool | What it does | Cost |
| --- | --- | --- |
| `screen_names` | Runs this Actor and returns the rows | Needs `APIFY_TOKEN`, billed per name |
| `list_sources` | Lists covered lists, source URLs, score scale, disclaimer | Free, local, no token |

```bash
cd mcp && npm install && npm run build
node scripts/smoke-test.mjs                          # initialize + tools/list + free tool, no token
APIFY_TOKEN=... node scripts/smoke-test.mjs --call   # real call
```

```json
{ "mcpServers": { "fairquery-sanctions-screener": { "command": "node", "args": ["/path/to/sanctions-watchlist-screener/mcp/dist/index.js"], "env": { "APIFY_TOKEN": "<your Apify token>" } } } }
```

Docker: the root `Dockerfile` builds the MCP server image (`docker build -t fairquery-sanctions-screener-mcp .`); it is also the Dockerfile for Glama. The Actor image is `.actor/Dockerfile`. `glama.json` lists `fairquery` as maintainer.

## Local development

```bash
npm install
npx apify run      # input from storage/key_value_stores/default/INPUT.json
npm test
```

## Kits & templates

Optional guides from Fairquery for wiring this Actor into agents and automations (the Actor works fine without them):

- [AI Agent Data Toolkit Quick-Start](https://fairquery.gumroad.com/l/qayngz) (PDF): MCP setup for Claude Desktop and Cursor, API calls, recipes, cost estimates.
- [n8n + Zapier Workflow Template Pack](https://fairquery.gumroad.com/l/koffbf): 10 importable n8n workflows for the four Fairquery Actors, plus Zapier setup guides.
- [Agent Prompt Pack for Research & Lead Ops](https://fairquery.gumroad.com/l/djdilu): 69 prompts for company research, lead cleaning, SEO and security reviews.
- [Agent Starter Kit: 10 copy-paste MCP + n8n recipes](https://fairquery.gumroad.com/l/idvrck) ($5): 10 copy-paste MCP + n8n recipes, with ready-made Claude/Cursor configs and 3 starter workflows.

## Disclaimer

**Not a certified screening service.** Results come from automated fuzzy matching against public lists downloaded at run time and are provided as is, without warranty. They may be incomplete, out of date or wrong. Always confirm potential matches with the official publication of the relevant authority (OFAC, European Commission, UK FCDO/OFSI, UN Security Council) and take legal advice before making compliance decisions. Data comes from public government sources; Fairquery is not affiliated with any of them.

## Links

- License: MIT
