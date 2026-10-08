# NEWS DISCOVERY: root cause and validation

## Inspection before implementation

Revision 5 used Responses API and returned `web_search_call` plus real source URLs. The source/citation parser was not losing the entire response. Its 48-hour diagnostic showed one accessible NVIDIA article with publication time `2026-10-07T18:45:28Z`, one extracted item, then zero verified items. The old diagnostic did not retain the extracted object, so that historical item alone could not distinguish URL mismatch from evidence mismatch.

A separate live replay of the unchanged extraction implementation isolated the failure: HTTP 200, matching canonical URL, valid publication date, one extracted item, but `evidence_match=false`. The model joined two passages with `...`; the old contiguous-string check discarded the whole article. The replay and source snapshot are retained locally in `storage/discovery-audit/nvidia-before.json`.

Additional confirmed gaps:

- Search was domain-restricted and frequently returned category pages or old articles.
- Missing/unrecognized publication dates were discarded before extraction.
- Extraction could succeed but every item be silently discarded by URL/evidence checks.
- Expanded searches did not reconsider rejected candidates from earlier windows.
- No RSS fallback existed; selection failed unless the exact three-item diversity rule passed.

## Focused change

`src/news/discovery.ts` owns search, extraction, merging, validation, deduplication, ranking and selection. `src/news/sources.ts` owns public URL validation, article parsing, publication dates and RSS/Atom parsing. OpenAI transport and all media/upload providers stay in the existing implementation.

- Responses search: required `web_search`, high context, explicit live access, source inclusion, no strict JSON schema or domain whitelist in the search request.
- A second Responses request extracts structured news using the raw answer, complete source list and fetched article text. Evidence is attached from the article itself, not from an LLM-generated quotation. Later script fact verification still runs.
- Per-source diagnostics distinguish failed fetches, listing pages, invalid extracted URLs, date rejection and invalid fields. Raw provider response, ID, output text, fetched sources and extraction are retained for audit.
- Date parser accepts ISO, textual and timezone-less values; timezone-less dates use UTC consistently. Missing publication dates remain null with `date_parse_failed=true`, `freshness_hours=null`, and `older_than_24h=true`. Modified dates never replace publication dates.
- Search expands 24 → 48 → 72 hours until at least five valid unique candidates exist. Earlier candidates are reconsidered in the wider window. RSS/Atom runs if fewer than five remain.
- All eight requested feed endpoints are attempted independently. Broken/nonexistent feeds are logged and skipped. HTML examples inside RSS CDATA are not mistaken for XML entity declarations.
- Prioritized publishers receive a ranking boost. Other valid public publishers are accepted. Internal-network destinations, invalid URLs, inaccessible pages and listing/archive pages remain excluded.
- Select up to three actual items, preferring diversity and two news plus one tool. A valid one/two-item result is retained; zero valid items is explicitly skipped. The small downstream integration changes allow 1–3 segments and nullable source dates. Automatic publishing still requires three dated items; manual review and fact verification remain intact.

## Run the live acceptance check

```powershell
npm.cmd run news:discover
```

This runs only real discovery/extraction/ranking and saves its own reservation/usage ledger. It does not mutate daily-run queues, produce media, send Telegram messages or upload to YouTube. The same `MAX_RUN_COST_USD` setting applies.

`storage/discovery-live/latest.json` contains full candidate/selected news, counts and usage. Full raw diagnostics live under `storage/diagnostics/<auditId>/rev-1/discovery-<timestamp>/`. The command prints the requested six counts and selected titles, publishers, URLs, publication times and freshness hours. Unknown dates are shown as null, never presented as verified fresh news.

`rawSourcesCount` counts unique URLs returned by OpenAI (including citations); `feedSourcesCount` is separate. `extractedNewsCount` counts extraction rows across search windows and feed batches before deduplication. Date/source/dedup counts describe the current merged window. Raw source loading decisions are recorded separately, before extraction. `finalSelectedCount` is set after ranking and selection.

Regression coverage includes the ellipsis failure, unknown dates, article/entity decoding, public nonpreferred sources, 24/48/72 reuse, RSS/Atom dates, failed feeds, explicit zero-source/extraction errors, duplicate sources, ranking and partial selection.

## Verified on 2026-10-08

- Build and 43 automated tests passed.
- Live search/extraction/rank audit `d4a0a1f6-a8d7-4ebd-a11d-df4d74a0e022` completed: 16 raw OpenAI sources, 16 extracted rows, 14 after date filtering, 9 after dedup/source validation, 3 selected. It needed 24h and 48h searches; RSS was not needed in that run. The report records one selected item with unknown publication date rather than inventing a fresh timestamp.
- Separate live feed check: 7 of 8 feeds fetched and parsed. Anthropic returned HTTP 404 and was skipped. GitHub parsed after fixing the CDATA false positive. Feed diagnostics are in `storage/discovery-audit/rss-live.json`.
- Replaying the original NVIDIA URL with a live article fetch and live extraction retained one item after the fix, publication `2026-10-07T18:45:28Z`. This is an original-URL replay, not a new web-search result. See `storage/discovery-audit/nvidia-after.json` for the before/after comparison.
- These checks cover news discovery/ranking. They do not claim a new end-to-end live video or YouTube upload.
