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
| `voice/right.wav`, `voice/left.wav` | "Right!" / "Left!" voice clips (male voice, 1.25x speed). Upload the whole folder (drag it onto the GitHub upload page). |
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
- **Mounted sideways (landscape)?** Either side up works, but the screen **must rotate**: turn off **Rotation Lock** (swipe down from the top-right corner). If the phone is on its side and the screen didn't turn, a red warning shows at the top after **Start**, because the arrow would point up/down instead of left/right. In landscape the arrow and the word LEFT/RIGHT sit side by side.
- Coming from v1.2.0 or earlier, the home-screen app may still be locked to portrait. If it won't turn sideways with Rotation Lock off, remove it from the home screen and add it again from Safari.
- Turn the phone volume up (the app always plays at full volume; the phone buttons set the loudness). The beep plays even with the silent switch on (iOS 17+).
- **Set Kick sensitivity** (Settings → **Kick sensitivity**, default **0.6 g**; lower = lighter kicks count):
  1. Tap **Clear peak**, then have your **lightest kicker** (e.g. an 8-year-old) kick the bag.
  2. Tap **Set to 70% of peak**. The slider moves to 70% of that kick's peak, so kicks that light or harder all count.
  3. Push the bag gently. If swaying alone turns the meter green, raise the slider a little.
- Updating from v1.0.0 replaces the old 2.0 g default with 0.6 g automatically.
- Each rep waits until the bag stops swinging before it starts.

## Results
- **0.312 s**: reaction time from beep to hit.
- **FALSE START**: the bag was hit while READY was showing (before the beep).
- **Ready time** (Settings): how long READY shows before the random delay starts, on every rep. The beep is the only sound.
- **Rest between kicks** (Settings, series only): 1 to 20 s, default 3 (was at least 5 s before v1.4.3; phones still on the old 5 s default switch to 3 s). The last time stays on screen with "Rest · next kick in 3…" while the student gets back into stance, then READY starts again.
- **NO KICK**: nothing above X within the timeout.
- **Series mode**: runs N reps (default 5). At the end, the main display shows **Fastest** and **Average** in large numbers, and the card below lists every kick. False starts, no-kicks and wrong-side kicks are left out of Fastest and Average. With side check on, it also shows **Correct side: 4 of 5**.
- **Kick side** (the ◀ Left | Right ▶ | Random buttons under Single/Series, default **Right**): at the beep, the whole screen turns into a big blinking amber arrow with LEFT or RIGHT under it. It stays up until the kick lands or the timeout runs out. Left and right are as seen by the student **looking at the screen**. The arrow is hidden during READY, so in Random mode students can't guess the side early. Random never picks the same side more than 3 times in a row. The side is shown with each result, in the series list, and in the Copy log `side` column (blank for a false start, since no arrow had shown yet). Tap the arrow screen to stop (it covers the Stop button).
- **Side check** (v1.3.0, round kicks): the app tells which side of the bag was kicked and checks it against the arrow.
  1. With the phone in its holder, open Settings → **Side check** and tap **Calibrate sides**.
  2. The arrow shows RIGHT: kick the right side of the bag 3 times, waiting for the arrow each time. Then LEFT 3 times. A chirp confirms each kick.
  3. It shows how many of the 6 kicks it sorted correctly (aim for 6 of 6) and "Side check: **on**". The calibration is saved, and it still works if the phone is flipped over in the holder. Recalibrate if the holder or the bag changes.
  - After each kick: **✓ Right side** with a chirp, or **Wrong side!** in red with a buzz. A kick it can't call clearly shows "side unclear" and doesn't count either way.
  - Settings → **Turn off side check** clears the calibration.
  - Copy log adds `hit_side`, `side_score` (+1 = clearly right, −1 = clearly left), `push_x`, `push_y` and `screen_angle`, for tuning.
- **Peak g and direction (°)**: shown for each hit. **Copy log** (Settings → Logs) copies all reps as CSV. Side check uses the **first jolt** of the kick (v1.6.0). Before v1.6.0 it summed the push over 80 ms, but on hard kicks the bag bounces back within ~50 ms and the sum came out backwards: on the 2026-10-14 class logs (182 kicks) the 80 ms sum matched the arrow 50% of the time, the first jolt 88% (some of the rest were students really kicking the wrong side). The saved logs keep both: `push` (first jolt), `push80` (old sum) and `joltMs`.

## Voice cue (v1.5.0)
- Settings -> Sound and screen -> **Voice**: when on, the phone says **"Right!"** or **"Left!"** instead of the beep, at the same moment the arrow appears. Off = the beep, as before.
- The voice is fixed (v1.5.1): the male Windows voice "David" at 1.25x speed, chosen after testing with students. Speed was set by speaking faster, not by speeding up the recording, so the pitch stays normal.
- Sound and screen now only has two checkboxes: **Voice** and **Flash screen on beep**. Volume and latency offset were removed (volume is always full, latency 0).
- Timing starts when the word starts (the clips have no silence in front), the same for every student. Times with the voice aren't directly comparable to times with the beep, so use one or the other when comparing.
- **Offline check** (v1.5.2): under the Voice checkbox, Settings shows **"✓ Voice saved for offline use"** or a red warning. If the clips are missing and the phone is online, the app downloads them by itself; anything the app fetches online is kept for offline use. Check for the green line before going to a gym with no signal.
- The clips were made with the built-in Windows voices (System.Speech), trimmed and made loud. If the voice folder is missing, the app falls back to the beep.

## Main screen and Settings (v1.4.1)
The main screen only has what students need: the timer display, Start / Reset, Single / Series, Left / Right / Random, and Recent results. **Reset** needs a **press and hold for 1 second** (a red bar fills the button); a quick tap does nothing except show "hold 1 sec", so students can't clear the results by accident. Everything for the coach is in **Settings**, grouped as Kick sensitivity (force meter and slider), Side check (calibrate / turn off), Logs (download, copy, delete), Timing, and Sound and screen.

## Saved logs (v1.4.0)
- Every kick is saved on the phone automatically, grouped by **session**. A session starts when the app opens or **Reset** is tapped. Calibration kicks are saved too.
- Each kick includes the detailed sensor readings from 0.2 s before impact to 0.4 s after (movement x/y/z and twist from the gyroscope), plus the arrow side, the side the app judged, and the settings.
- **Download logs** (Settings → **Logs**, with a session and kick count) saves everything as one `kicktimer-logs-YYYYMMDD-HHMM.json` file. On the iPhone it opens the share sheet: **Save to Files**, AirDrop, or Mail.
- Logs survive closing the app. About 3 MB is kept (thousands of kicks); the oldest sessions are dropped first.
- Settings → **Delete saved logs** clears them (download first if you want to keep them).
- **Copy log** still copies this session's summary as CSV.
- **Sound diagnostics** (v1.5.3): the logs also record app opens (online/offline, home-screen, offline-ready), each Start tap's sound state before/after (running / suspended / interrupted, recreated or not), each voice clip load (ok, or which step failed and the error), what each rep played (voice or beep) with the sound state at that moment, and any app errors. A session is saved even with no kicks, so a failed attempt still shows up.
- **sound badge** (top right, next to sensor): "sound: on" (green) or "sound: off · tap Start" (red). If the sound system was stuck (e.g. after a call or Siri), tapping Start rebuilds it.

## Accuracy notes
- Safari reports motion about 60 times a second, so times are accurate to about ±17 ms. That's fine for kick reactions (about 200–600 ms).
- Speaker delay is the same on every kick, so it applies equally to everyone and comparisons stay fair. (The Latency offset setting was removed in v1.5.1.)
- Word results (NO KICK, FALSE START) use smaller text, and with the phone on its side the display shrinks to fit, so Start/Stop always stays on screen (v1.5.1).

## Future ideas
- Kick power on the main screen: big peak g for each kick plus the session best ("hardest kick" game). Same bag only for comparing.
- Timed kick count: "race to 10 kicks" (time it) or "most kicks in 10 s" (count them). Needs each fast kick counted separately.
- Two-person face-off: two students on opposite sides of the bag, both right-leg round kicks, so they push the bag opposite ways. The first jolt decides who hit first (calibrate Player 1 x3, Player 2 x3; beep start; ties within ~20 ms; running score).
