# KickTimer

Kick reaction timer for the iPhone. The phone is strapped to the bottom of a kick bag. It shows **READY** (silently, with no countdown numbers or ticks), waits a random delay, beeps, and times how long until the bag is hit hard enough (force threshold X, in g).

It's a web app: it runs in iPhone Safari, installs to the home screen, and **works fully offline** once installed.

## Files
| File | Purpose |
|---|---|
| `index.html` | The screen |
| `styles.css` | Look and feel |
| `app.js` | All logic: ready/delay, beep, sensor, timing, settings |
| `sw.js` | Offline cache (service worker) |
| `manifest.webmanifest`, `icon-*.png` | Home-screen app name and icon |
| `.claude/launch.json` | Local test server for the PC |

## Test on the PC
Run a local server with the portable Python:

```
C:\Temp\Projects\_python\python.exe -m http.server 8765 --bind 127.0.0.1 --directory C:\Temp\Projects\iOS_KickTimer
```

Open http://localhost:8765. A PC has no motion sensor, so after tapping **Start** use **Simulate hit** (or the Spacebar) as the kick.

## Put it on the iPhone (once, at home on Wi-Fi)
iPhone Safari only allows the motion sensor on an **https://** site, so the files need free web hosting:

- **GitHub Pages**: create a free GitHub account and a repository. Upload the files, then go to Settings → Pages → deploy from the `main` branch. You get a link like `https://<name>.github.io/kicktimer/`.
- **Netlify Drop** (no git needed): go to app.netlify.com/drop and drag this folder onto the page.

On the iPhone:
1. Open the link in **Safari**.
2. Tap Share → **Add to Home Screen**.
3. Open KickTimer from the home screen and tap **Start**, then **Allow** motion access.
4. Test with **Airplane Mode** on to confirm it works offline.

## Updating
1. Change the files.
2. Bump `CACHE` in `sw.js` and `VERSION` in `app.js`, then upload again.
3. On the iPhone (v1.1.1 and later), open the app on Wi-Fi. It checks for a new version each time it opens or comes back on screen.
   - Nothing on screen: it reloads itself to the new version.
   - Results on screen or a drill running: it shows **New version ready · tap to update** at the bottom instead, so nothing is wiped.
   - Settings → **Check for update** checks on demand.
4. The version number is shown at the bottom of the screen.

**Stuck on an old version?** A home-screen app keeps its own copy, apart from Safari, so refreshing Safari doesn't update it. Press and hold the icon → Remove App → Delete from Home Screen, then add it again from Safari. Phones on v1.0.0 or v1.1.0 need this once to get the auto-update.

## Mounting and calibrating
- Put the phone in a padded case and strap it firmly to the **bottom** of the bag, away from feet. Mount it the same way every time.
- Turn the volume up. The beep plays even with the silent switch on (iOS 17+).
- **Set Kick sensitivity** (the slider in the **Force** card, default **0.6 g**; lower = lighter kicks count):
  1. Tap **Clear peak**, then have your **lightest kicker** (e.g. an 8-year-old) kick the bag.
  2. Tap **Set to 70% of peak**. The slider moves to 70% of that kick's peak, so kicks that light or harder all count.
  3. Push the bag gently. If swaying alone turns the meter green, raise the slider a little.
- Updating from v1.0.0 replaces the old 2.0 g default with 0.6 g automatically.
- Each rep waits until the bag stops swinging before it starts.

## Results
- **0.312 s**: reaction time from beep to hit.
- **FALSE START**: the bag was hit while READY was showing (before the beep).
- **Ready time** (Settings): how long READY shows before the random delay starts, on every rep. The beep is the only sound.
- **Rest between kicks** (Settings, series only): at least 5 s, default 5. The last time stays on screen with "Rest · next kick in 5…" while the student gets back into stance, then READY starts again.
- **NO KICK**: nothing above X within the timeout.
- **Series mode**: runs N reps (default 5). At the end, the main display shows **Fastest** and **Average** in large numbers, and the card below lists every kick. False starts and no-kicks are left out of Fastest and Average.
- **Peak g and direction (°)**: shown for each hit. **Copy log** copies all reps as CSV. This is data for the future left/right detection.

## Accuracy notes
- Safari reports motion about 60 times a second, so times are accurate to about ±17 ms. That's fine for kick reactions (about 200–600 ms).
- **Latency offset** (Settings) shifts every time by a fixed number of ms if you want to correct for speaker delay. It applies equally to everyone, so comparisons stay fair.

## Future ideas
- Voice cue "Right!" / "Left!" in place of the beep.
- Full-screen arrow cue (voice, arrow, or both).
- Side detection from push direction (round kicks), with "WRONG SIDE" flagged.
