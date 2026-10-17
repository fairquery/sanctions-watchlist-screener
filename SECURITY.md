# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| Latest Apify Actor build and `main` branch | Yes |
| Older releases | No. Please upgrade first |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Email **fairquery@proton.me** with a description, the affected version, reproduction steps and the impact. Or
- Use **Report a vulnerability** on this repository's **Security** tab (GitHub private vulnerability reporting).

Response targets:

- Acknowledgement within **3 business days**
- Initial assessment within **7 days**
- A fix or mitigation for critical issues within **30 days**, with coordinated disclosure and credit if you want it

Please don't access other users' data or degrade the service while testing. Report vulnerabilities in third-party platforms (Apify, RapidAPI, npm, GitHub) to those vendors.

## Data handling

This repository contains an Apify Actor and a local stdio MCP server (`mcp/`).

- **Actor runs** execute in *your own* Apify account. Input is stored as the run's `INPUT` record and results in the run's default dataset, both unnamed storages that Apify deletes automatically under your plan's data retention. Besides a `RUN_SUMMARY` record, the Actor writes nothing else, keeps no copies and sends no data to Fairquery. Logs contain counts and status, not your input content.
- External calls: only downloads of the OFAC, EU, UK and UN lists from their official sources. Screened names are matched in memory and never sent to any third party.
- **MCP server:** runs on your machine. Free tools make no calls to Apify or Fairquery. Paid tools run the Actor with your own `APIFY_TOKEN`, which is read from the environment only when needed and never logged or returned.
- The repository contains no credentials.

Full details: https://fairquery.github.io/security/
