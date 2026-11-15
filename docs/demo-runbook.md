# Live demo runbook

How to run the creator flow live and what to do if a provider is slow or fails. Use the [Mori Drinks seed and presenter path](demo-presenter.md) for the starting business and click sequence (D2 in [issue #6](https://github.com/Emmit3/yap./issues/6)); this page covers the safety net (D3).

## The day before

1. Put the keys in `apps/api/.env` (see [API setup](api-setup.md)). Narration and frame review both use `OPENAI_API_KEY`.
2. Start the app with `npm run dev` and run `npm run check:connections`. Every provider you plan to show must report ready.
3. Open the cost review in the studio and confirm the available budget covers at least two full films. One 15-second film with narration is quoted at about USD 1.35.
4. Make one complete film end to end, with the same idea and photos you will use live. Watch and listen to it.
5. Save it as the fallback:

   ```sh
   npm run demo:snapshot -- save demo
   ```

   The command prints the studio link for each finished film in the snapshot. It refuses to save when no finished film exists.

## Just before the demo

1. `npm run demo:snapshot -- list` shows the saved fallback and its film link.
2. Start the app and run `npm run check:connections` again.
3. Open the fallback film's link in a second browser tab and leave it there.

## If something fails live

- **A provider is slow or a clip fails review:** switch to the second tab and show the finished film. A failed review never retries on its own; a retry needs a fresh quote and approval, which is too slow for a live audience.
- **The app's data is in a bad state:** stop the app, then restore the fallback and start again:

  ```sh
  npm run demo:snapshot -- restore demo
  npm run dev
  ```

  The data that was replaced is kept under `artifacts/demo-snapshots/_replaced-<time>`.

## What restore does to the budget

The data directory holds the spending ledger. Restoring an older snapshot would make the app forget spending recorded after the snapshot was saved, while the providers still bill it. The command refuses in that case. `--allow-budget-rewind` overrides this; use it only when you accept that the app's remaining budget will read higher than what was really spent.

Snapshots live in `artifacts/demo-snapshots`, which Git ignores. They contain your photos, films and ledger, so do not commit or share them.
