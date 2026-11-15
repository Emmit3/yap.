# Mori Drinks presenter path

This is a fictional independent drinks shop, prepared for the creator studio demo in [issue #6](https://github.com/Emmit3/yap./issues/6). Its idea is a 15-second vertical film about an iced matcha break and the care behind a good coffee, ending with “Make time for a little Mori.” No real address, prices, hours, health claims or customer testimonials are supplied.

The two existing photos are illustrative stock, not a Mori location or Yap-generated imagery: [iced matcha by Gaia&Co](https://unsplash.com/photos/iced-matcha-latte-on-table-VKWjhlgFFwc) and [espresso preparation by Aleksey Cherenkevich](https://unsplash.com/photos/barista-making-coffee-with-an-espresso-machine-a94kO95_o9g), recorded under the Unsplash License in [credits.json](../public/media/credits.json). The seed verifies their recorded SHA256 hashes before any API request and saves attribution in each photo description.

## Prepare the starting point

Start the app using [API setup](api-setup.md), then run from the repository root:

```sh
npm run demo:seed
```

The command prints the saved creator studio link. It creates one labeled creator session, its linked workflow, the prepared idea, and two supplied photos. It never calls analyze, prepare, quote, approve or produce, and never publishes. No provider key is needed to seed. The film is still unapproved and unproduced.

For different local ports:

```sh
npm run demo:seed -- --api http://127.0.0.1:3002 --web http://127.0.0.1:5174
```

Both origins must be loopback addresses. Keep the ignored `artifacts/demo-seed/mori.json` pointer: rerunning reopens the same fixture and preserves your edits. An interrupted photo upload resumes from the saved workflow by matching hashes; missing descriptions are completed without replacing your own descriptions. If the pointer is stale or belongs to another API, preserve it and deliberately create another fixture:

```sh
npm run demo:seed -- --new
```

This archives the previous pointer and creates a separate session. It does not delete records or reset the ledger. A stale `.lock` requires checking that no seed process is still running before removing that one lock file. A lost response to the initial session-create request can leave a labeled unused session; inspect Your creations before deliberately starting again. Upload-response interruptions are resumable.

## Presenter click path

1. **Fresh start.** Open the printed link in a fresh browser tab. In Your creations, reopen Mori Drinks to show the idea and two photos persist. Explain that Mori is fictional and its photos are licensed illustrations.
2. **Idea and media.** In Guided, inspect the starting idea and source descriptions. Answer the product name, audience and message questions in your own words; save direction. Switch to Director and back to show the same saved creation. Do not introduce prices or location facts.
3. **Research and sources.** Open View analytics or the creator research panel. Inspect source attribution, coverage and limitations before selecting a technique. Keep external films separate from Mori facts and production photos. A no-key run reports unavailable live search; **Watch the research demo** is explicitly a synthetic example, not live evidence.
4. **Script and shot review.** Return to Create and prepare script and shots only when you intend to run the configured drafting stage. Open Director, read and edit the exact script and timings, inspect every supplied-photo assignment and creative reference, and save changes. Preparation can use a paid configured model; seed itself never prepares it.
5. **Sound and subtitles.** Choose Narration voice and Background music in Sound for the whole film, or choose none. Explain that narration is AI-generated and priced in the quote. Review the subtitle controls if present in the current build; burned-in subtitles and a downloadable subtitle file are separate from the social-post caption. If those controls are absent, state that subtitle delivery has not been implemented in that build. Do not describe an absent feature as demonstrated.
6. **Cost and exact approval.** Review the current film, request its quote, inspect provider/model, attempt limits, audio, ceiling and available shared budget. Obtain the intended exact approval before starting production. Editing the saved plan requires a new quote/approval. Seed reuse never grants approval.
7. **Clip and finished-film review.** Show actual job activity, clip audits and any failed review honestly. Watch the complete finished film; listen to narration/music and inspect subtitle timing, safe areas and the final frame. A failed clip does not become accepted footage or an automatic free retry.
8. **Export and handoff.** Download the MP4 and separate social-post caption. Download the subtitle file only if that feature is available and verified. Playback-check the actual downloads. Posting is manual; no account is connected or content published by this path.

## Rehearsal and fallback

Use the existing [live demo runbook](demo-runbook.md) for readiness, `demo:snapshot`, the finished-film fallback tab and the spending-ledger restore guard. This seed is a starting point, not a finished-film snapshot. Do not restore an older data directory to manufacture a fresh budget.

Keep two fresh-start rehearsals as private evidence under ignored artifacts/local-context. For each, record the seed/session ID, provider readiness, approved quote, actual job IDs, downloaded MP4/caption/subtitle files, and playback findings. Label a local photo render or synthetic replay accurately. No-key seed and automated API tests do not prove real paid generation, narration, subtitles, or the two real-provider rehearsals; those remain pending until actually exercised with the intended credentials and approval.
