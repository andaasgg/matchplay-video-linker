# Matchplay Video Linker

Chrome extension that links timestamped YouTube videos to games on
[app.matchplay.events](https://app.matchplay.events). Matchplay has no write API, so it fills in
the site's own **Add video** form, using your signed-in session.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder
4. Pin the extension so its icon is easy to reach

Your Matchplay account needs a streamer tag (account settings), or the site won't show the form.

## Use

1. Open the tournament on Matchplay. The qualifying tournament or one of its finals both work.
2. Click the extension icon. A panel opens on the left.
3. Enter the YouTube link, then click **Find games**. It reads the video description. To use a
   different list, paste it in the box instead. This can take up to a minute, because Matchplay
   allows 6 API requests a minute without a token.
4. Review the list. Only lines marked **Ready** are ticked. Pick a game by hand for any **No match**.
5. Click **Add N videos**. Leave the tab open and visible while it runs.

Tick **Rehearse only** to run every step but cancel each form, so nothing is saved.

At the end it checks the Matchplay API and reports how many videos it could confirm. A failure
stops the run, and rerunning is safe: games that already have the video show as **Linked**.

## List format

```
1:36 Round 1 · Pharaoh – Indigo I., Drew D., Finley F., Alex A.
2:39:08 A Finals – Semifinals – Group 2 · Sing Along – Finley F., Harper H., Drew D., Gray G.
https://youtu.be/MsUegzX0a1c?t=96 Round 1 · Pharaoh – Indigo I., Drew D., Finley F., Alex A.
https://youtu.be/MsUegzX0a1c?t=96
```

- A prefix such as `A Finals` selects the linked tournament whose name starts with it.
- `Group N` only breaks ties. Matchplay stores it as `set + 1`, so `Group 10000` is the tiebreaker.
- Players match in any order, by first name and last initial.
- A bare link has no label to match on, so you choose its game by hand.

## Tests

```bash
node --test
```
