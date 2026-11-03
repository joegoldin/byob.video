# HackerTube video IDs

`hackertube.json` is an ID-only projection of the **2026-10-31** [HackerTube data export](https://hackertube.org/data), downloaded and reviewed on 2026-11-03.

## Attribution and license

Credit **[HackerTube](https://hackertube.org)** and the **[open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news)** dataset, under the **[Open Data Commons Attribution License (ODC-By) v1.0](https://opendatacommons.org/licenses/by/1-0/)**. This data is not covered by the application's code license. Hacker News data is provided by Y Combinator; comments remain their authors' work. Video titles and channel names belong to their creators. BYOB is not affiliated with these projects, YouTube, Google, Hacker News or Y Combinator.

The application also displays these credits in room settings. We do not redistribute upstream comments, summaries, titles, channel names, embeddings or code.

## Provenance and filtering

- Original file: `https://hackertube.org/download/videos.jsonl`
- Original size: **8,634,516 bytes**, **6,454 records**
- Original SHA-256: `4a63125d00076015eb04edf0eb65f9524410bb60f88c3b67d61e767a19389b1e`
- Retained: **4,654 unique YouTube IDs**
- Excluded: **1,658** records with no HN recommender, then **142** recommended records marked news-only

HackerTube distinguishes positive recommendations from mere citations, jokes and criticism. Its labels are model-generated and can be wrong. We retain positively recommended, non-news videos; this is not a review of every video's content, availability, age suitability or accuracy.

## Security review

The complete video JSONL was parsed and checked, without running upstream code or following instructions in the downloaded material. Every ID matched `[A-Za-z0-9_-]{11}`, no IDs were duplicated, and every supplied video URL exactly matched the canonical YouTube watch URL constructed from its ID. A scan for HTML/script/scheme markers found two matches: harmless video titles beginning `JavaScript:`. No executable payload was identified in the reviewed video JSONL. This does not claim that unneeded files in the full archive were scanned.

The importer has size/line bounds, rejects malformed records, arbitrary video URLs, duplicate IDs and prototype-related top-level keys, and verifies the approved hash and source count before writing. Only allowlisted IDs and provenance/counts enter the snapshot. Free-form fields are discarded even if they contain HTML, instructions or script-like strings. We do not download the full archive, extract files, load pickle/NumPy data or run bundled scripts.

At runtime the Worker never fetches HackerTube. It batches at most 50 IDs through the existing YouTube Data API client, admitting only requested IDs with current titles and explicit embed permission. The source joins the existing **curated** bucket, preserving pool balancing, weighting, repeat decay and cross-source deduplication. Existing on-demand daily refresh jobs paginate the snapshot; there is no new recurring idle alarm. A configured `YOUTUBE_API_KEY` is required, as with curated playlists. An unavailable API yields no new source entries; other sources remain available.

A complete successful refresh takes **94 YouTube `videos.list` requests**, plus existing validation of selected candidates. No additional third-party credentials or runtime HackerTube calls are needed. Dataset URLs are not used for fetches or playback; YouTube URLs are constructed from validated IDs.

## Reproduce or update

From the repository root, with Node dependencies installed (fish syntax):

```fish
curl --fail --silent --show-error --max-time 60 --max-filesize 12582912 https://hackertube.org/download/videos.jsonl -o /tmp/hackertube-videos.jsonl
node workers/scripts/import-hackertube.mjs /tmp/hackertube-videos.jsonl
node --test workers/test/hackertube.test.mjs workers/test/pool-services.test.mjs
```

The importer intentionally refuses any export whose hash/count differ from the reviewed version. If upstream changes, inspect the new file and licensing first, then deliberately update the pinned date/hash/count in `workers/scripts/hackertube-data.mjs`, regenerate the projection, and update this notice and regression counts. Do not bypass the hash check to accept an unreviewed download.
