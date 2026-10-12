# TSS Viewer

A browser app for viewing and comparing Tektronix oscilloscope captures (`.tss` files saved by
MSO5/6-series scopes). Compare waveforms from several captures, choose FastFrame frames, shift
waveforms in time, and build math channels such as power and energy.

- **Nothing to install.** It is plain HTML and JavaScript: no Node.js, no Python, no build step, no dependencies.
- **Works offline.** No internet connection is needed once you have the files.
- **Your data stays on your PC.** `.tss` files are read inside your browser and are never uploaded anywhere.

## Getting started

### 1. Requirements

A current desktop browser:

| Browser | Minimum version |
|---|---|
| Google Chrome | 103 or newer |
| Microsoft Edge | 103 or newer |
| Mozilla Firefox | 113 or newer |
| Safari (macOS) | 16.4 or newer |

The app needs the browser's built-in `DecompressionStream` to unzip `.tss` files, and older
versions don't have it. If your browser is too old, the status bar at the bottom of the app says so.

### 2. Download the code

**Option A: download a ZIP (no Git needed)**

1. On the repository's GitHub page, click the green **Code** button, then **Download ZIP**.
2. Extract the ZIP anywhere, e.g. `Documents\TSSviewer`.
   Extract it first; don't open `index.html` from inside the ZIP preview.

**Option B: clone with Git**

```
git clone https://github.com/<your-account>/TSSviewer.git
```

To update later, run `git pull` in that folder (or download the ZIP again).

### 3. Open the app

Double-click **`index.html`**. It opens in your default browser and is ready to use.

If `index.html` opens in a different program (an editor, for example), right-click it, choose
**Open with**, and pick Chrome, Edge or Firefox. Or drag `index.html` onto an open browser window.

Tip: bookmark the page (Ctrl+D) so you can reopen it quickly.

### 4. Load captures

- **Open files**: select one or more `.tss` files. Hold Ctrl or Shift to select several.
- **Open folder**: select a folder. Every `.tss` file below it is listed.
  With up to 6 files they load straight away. With more, click a file in the list to load it.
  Chrome and Edge then ask *"Upload N files to this site?"*. Click **Upload**. That is the browser's
  standard wording for letting the page read the files. Nothing leaves your computer.

Press **?** in the top-right corner for the mouse and keyboard reference.

### Alternative: run it from a local web server

Double-clicking is all most people need. If your company's browser policy blocks pages opened from
disk, or the page stays blank, serve the folder with any static web server instead. With Python installed:

```
cd TSSviewer
python -m http.server 8765
```

Then browse to <http://127.0.0.1:8765>. Stop the server with Ctrl+C.

### Alternative: host it on GitHub Pages

The repository's owner can publish the app so colleagues only need a link:

1. On GitHub, open the repository's **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**, select the `main` branch and the `/ (root)` folder, then **Save**.
3. After about a minute the app is live at `https://<your-account>.github.io/TSSviewer/`.

Files are still read only inside each user's browser; GitHub never receives any `.tss` data.
If the repository is private, Pages availability depends on your GitHub plan.

## Troubleshooting

| Problem | What to do |
|---|---|
| The page is blank or the buttons do nothing | Make sure the whole folder was extracted, with `css/` and `js/` next to `index.html`. Then try the local web server described above. |
| Status bar says the browser lacks `DecompressionStream` | Update your browser (see *Requirements*). |
| "Could not read file: Not a zip archive" | The file is not a `.tss` capture, or it was cut short while copying. |
| "Only WFM version 3 is supported" | The capture comes from a scope that writes an older WFM format. Only version 3 (MSO5/6 series) is supported. |
| Channel names are wrong | Put a `tss_corrections.txt` with lines like `channel:BadName,NewName` in the same folder as the captures, and select it together with the `.tss` files (or use *Open folder*). |
| Very large files or many frames feel slow | Show fewer channels or frames at once. Each file's channels are decoded only when you switch them on. |
| Math channels or theme from last time are gone | They are saved in the browser's local storage. A different browser, a private window, or clearing site data starts empty. |

## Features

- **Load** `.tss` files with *Open files* or *Open folder*.
  A `tss_corrections.txt` (`channel:BadName,NewName`) in the same folder renames channels.
  With more than 6 files, they are listed and each one loads when you click it.
- **Channels:** toggle them per file, or across every file with *Channels in all files*.
- **Frames (FastFrame):** type `1-5, 8` or click the frame buttons. Alt+click selects one frame only.
- **Panes:** one per channel (overlays the same signal from every file), one per file, one per frame, or a single pane.
- **Time shift:**
  - Drag a waveform left or right. *Dragging moves* sets whether only that waveform moves or the whole file.
  - Or type a shift in the waveform's Δt box or the file's *Shift* box: `12.5n`, `-3 us`, `1e-9`, `40 samples`.
  - ←/→ nudges the selected waveform by 1 sample (Shift: 10 samples, Alt: 1 pixel).
- **Navigate:**
  - Wheel zooms time; Shift+wheel or wheel over the Y axis zooms Y.
  - Drag the background to pan; Shift+drag or *Box zoom* zooms to a box.
  - Double-click or `F` fits everything.
- **Math channels** (*ƒ Math*):
  - Quick buttons: A÷B, A×B, A+B, A−B, ∫A dt, dA/dt, |A|.
  - Or type any formula, e.g. `integ(Vd*Is)` or `smooth(diff(Is), 2n)`.
  - A definition applies to every loaded file that has its input channels, and is remembered between sessions.
  - Units are inferred (V×A → W, ∫W dt → J, A/s, Ω).
  - Inputs use their own Δt shifts, so deskewing an input also updates the result.
- **Frame trends** (*Trends* or `T`): measure a channel in a time window on every FastFrame frame and plot the result against frame number or trigger time.
  - Measurements: mean, integral, RMS, min, max, peak-peak, or the value at one time. Math channels work too, e.g. the integral of `Vd*Is` for energy per pulse.
  - Type the window (`200n` to `500n`) or click *From cursors*. The window is in displayed time, so a waveform's Δt shift moves it relative to the window; the window being edited is shaded on the plot.
  - Every loaded file with that channel gets its own line. Hover to read one frame's values in the table; click a point to show that frame (Shift+click adds it).
  - *CSV* saves every value. Measurements are remembered between sessions.
- **Measure:** `C` shows cursors A/B with Δt and each waveform's values at A and B. The legend shows each waveform's value at the mouse.
- *PNG* saves the plot; *Scope screenshot* opens the screenshot stored in the capture.

## Code

Plain JavaScript loaded with ordinary `<script>` tags, so it also runs from `file://`. To change it,
edit the files and reload the page. Load order is set in `index.html`.

| File | Purpose |
|---|---|
| `js/zip.js` | Minimal zip reader (uses the browser's `DecompressionStream`) |
| `js/wfm.js` | WFM v3 parser, ported from `DynamicAnalytic/dpa/tekwfm.py` (incl. FastFrame trigger times) |
| `js/tss.js` | `.tss` reader: channel labels from the nested `.set`, corrections, lazy channel decode |
| `js/series.js` | One frame of one channel, with a min/max pyramid for fast drawing of long records |
| `js/math.js` | Math expression parser and vectorised evaluator (integ, diff, smooth, …) with unit inference |
| `js/trend.js` | Frame trends: per-frame window measurements (mean, integral, …) and their chart |
| `js/plot.js` | Canvas plot: stacked panes, zoom/pan, drag-to-shift, cursors |
| `js/app.js` | UI: files, channels, frames, waveform list, shifts |
