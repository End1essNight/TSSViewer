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
  Select their test-condition `.json` files too, to see the test conditions.
- **Open folder**: select a folder (a day, a month or more). Every `.tss` file below it is found,
  together with its test conditions when a matching `.json` file is in the same folder (see
  *Test conditions* below). A picker opens: narrow the list by condition values (e.g. `chip_id`
  02016018, `high_voltage` 600), tick the captures you want and click **Load**. Nothing is loaded
  before that. Captures you did not pick stay available under **Conditions** (or *Choose…* in the file list).
  Chrome and Edge first ask *"Upload N files to this site?"*. Click **Upload**. That is the browser's
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
  With *Open folder* you pick the captures to load by their test conditions. With *Open files* and
  more than 6 files, they are listed and each one loads when you click it.
- **Test conditions** from a `.json` file saved next to each capture:
  - A JSON file belongs to a capture in the same folder when the names match (`run1.tss` + `run1.json`),
    or match after a leading prefix of letters is dropped (`Tek20261007T114340.tss` + `Cfg20261007T114340.json`).
  - Each file's conditions are listed in its card. Conditions that differ between the listed files
    are highlighted and also shown under the file name.
  - *Conditions* opens the file picker: every capture (loaded or not) against its conditions.
    Pick a value under a condition to show only those files; each box lists the values left by the
    other filters, with how many files have each. Click a condition's name to sort by it.
    Tick rows (or the header box for every file shown) and click *Load*.
  - Mark *name* under some conditions and click *Name files from marked* to name the files after
    them (e.g. `high_voltage=600 · period_ms=100`) in legends and trends.
  - Closing a file puts it back among the picker's candidates.
  - The file filter also searches the conditions, e.g. `high_voltage 600`.
- **Channels:** toggle them per file, or across every file with *Channels in all files*.
- **Frames (FastFrame):** type `1-5, 8` or click the frame buttons. Alt+click selects one frame only.
- **Panes:** one per channel (overlays the same signal from every file), one per file, one per frame, or a single pane.
- **Time shift:**
  - Drag a waveform left or right. *Dragging moves* sets whether the whole file moves (the default) or only that waveform.
  - Or type a shift in the waveform's Δt box or the file's *Shift* box: `12.5n`, `-3 us`, `1e-9`, `40 samples`.
  - ←/→ nudges the selected waveform by 1 sample (Shift: 10 samples, Alt: 1 pixel).
- **Overlay, level and scale** (display only: readouts, cursors, math, trends and double-pulse values use the real values):
  - Select a waveform (click it or its row on the right). Its row shows the level controls.
  - **Overlay on another channel's pane** (*Panes: One per channel*): pick *In Vd* (or another channel) to draw
    it in that pane, scaled to fit. Example: make a math channel `diff(Is)` (or `smooth(diff(Is), 1n)`), select it
    and pick *In Vd* to compare dI/dt with the Vd edge. The pane keeps Vd's axis and unit, and its title lists
    the overlaid channels.
  - **Move it vertically:** drag the waveform up or down (the first few pixels decide: sideways shifts time,
    up/down moves the level), or use ↑/↓ (1 pixel, Shift: 10). The pane's axis then stays fixed (*Y locked*);
    double-click to fit again.
  - **Scale:** Alt+wheel over the plot scales the selected waveform about the mouse position, or type the scale
    (`×`, e.g. `5e-9`, `10n`) and offset (`+`, in the pane's unit). *Fit* scales and moves it to fill the pane
    over the shown time span. *0* returns it to its own pane with scale 1 and offset 0.
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
  - *CSV* saves every value of every plotted file (loaded or measured without loading) in one
    `tss-trends.csv`, one row per file and frame. Columns: `file path` (the folder, relative to the
    folder you opened), `file name`, every test condition from the
    `.json` files (blank for a file without one), `frame`, `trigger time [s]`, then one column per
    measurement. This suits Excel pivot tables or pandas, e.g. grouping by `high_voltage`.
    Measurements are remembered between sessions.
  - **Apply the same measurements to many files** without loading them: define the measurements
    (e.g. on one loaded file), then click *Measure files…* (or *Conditions*), filter and tick the
    files, and click *Measure ticked*. Each file is opened, measured on every frame and released,
    so a whole folder fits in memory. The results are plotted with the loaded files; click a point
    to load that file at that frame. These files have no time shifts. After adding or changing a
    measurement, click *Measure again*.
- **Double pulse** (*Double pulse* or `D`): extract double-pulse switching parameters with the
  config-free `dpa` algorithm, version 3.5 (ported from `double-pulse-analytics/dpa/analysis.py`, same results).
  1. **Captures:** tick the double-pulse files among the listed files. A file is ticked when first listed if it
     has a Vd channel. Files that are not loaded are opened just for the extraction.
  2. **Channels:** assign Vd (required), Vg, Is, Ig and Vgi (optional). *Auto* finds them by their usual
     names (`Vd`/`Vds`, `Vg`/`VGO_LS`, `Is`/`Id`, `Ig`, `Vgi`, case-insensitive). Next to each one you can see
     which channel it uses in the ticked files, and in how many files it is missing.
  3. **Parameters:** switching times (tdon, tf, tdoff, tr; needs Vg), switching energy (Eon, Eoff; needs Is),
     gate charge (Qgoff, Qgon; needs Vg and Ig), dV/dt and dIs/dt (10–90 % and peak), and Vd turn-off overshoot.
     - **Thresholds:** click ⚙ next to a parameter to change its thresholds, e.g. the Vd upper level for
       switching times from 90 % to 85 %. Percentages are of each signal's 0–100 % swing at the switching event.
       The editable thresholds are:
       - Switching times: the Vg and Vd levels.
       - Energy: **Is deskew** (default 0 ns), signed like the Δt boxes: a positive value moves Is later (to the
         right), so a deskew of +1 ns gives the same values as a Δt of +1 ns on the Is waveform. It adds to that Δt.
         It applies to every parameter that uses Is, the switching energy above all. Note: dpa's `deskew_ns` has the
         opposite sign (dpa `deskew_ns = 1.3` is `-1.3` here). Marks found on Is are drawn on the Is waveform itself.
       - Energy: where Eon/Eoff start and end. Eoff ends on Is (0 %, the default) or on Vd (e.g. 99 %).
         Ending on Vd leaves out the current tail after Vd has risen, so Eoff is smaller.
       - Gate charge: where Qg starts and ends, and the Ig-settled band.
       - dV/dt and dIs/dt: the upper and lower levels.
       - Vd overshoot: where the peak search starts, and how long it lasts.

       Changed values are highlighted and counted on the ⚙ button, and *Defaults (v3.5)* restores them.
       The thresholds are remembered between sessions. Result columns keep their standard names
       (e.g. `dV/dt_on_90_10`) whatever the levels. The CSV header lists every threshold used, with `*` on the
       changed ones. When the thresholds change after an extraction, the panel says *Thresholds changed: Extract again*.
  4. **Extract:** one result row per file (and per frame for FastFrame captures, or only the frames shown).
     The last row, *Average*, is the mean of each column over the results that have a value in it (hover a value for the count).
     The Δt shifts of loaded waveforms are applied, so you can deskew Is against Vd before extracting.
     A value that cannot be extracted is left empty and the *Issues* column says why.
  5. **View extraction windows:** click a result row to show that capture alone. It first shows the whole
     record with no marks. Click a parameter's chip to show its marks: every threshold crossing as a dashed line and
     a dot on its waveform, and the Eon/Eoff/Qg integration windows shaded with their values. *Turn-off* / *Turn-on*
     zoom to the hard switching events. The chips and zoom you pick stay for the next rows you click, until the
     next extraction.
     - **Overlay files:** Ctrl+click (or Shift+click) more rows to add them; Ctrl+click a shown row again, or the
       × on its file chip, to remove it. In an overlay, marks take their waveform's colour and the parameters are
       told apart by dash pattern (see the *Show* chips). Only one file's marks are labelled: the last one added,
       or click a file chip to label that file instead.
     - **Move waveforms:** drag a waveform (or nudge it with ←/→) to compare edges. Its marks move with it.
       In *Whole file* mode, or with the file's *Shift* box, every mark of the file moves. When waveforms of a file
       move relative to each other, e.g. Is against Vd, the values no longer match the plot and
       *Moved since extraction* appears. Click *Extract* again to get values for the new deskew.
  6. **Download CSV:** `double-pulse-parameters.csv` has one row per file and frame, with the same `#` header
     lines as the dpa batch CSV, the test conditions, Vdc/Ioff/Ion, every parameter, the channels used,
     time shifts and errors, and an *Average* row at the end.
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
| `js/cond.js` | Test-condition `.json` files: parsing, pairing with captures, finding conditions that differ |
| `js/series.js` | One frame of one channel, with a min/max pyramid for fast drawing of long records |
| `js/math.js` | Math expression parser and vectorised evaluator (integ, diff, smooth, …) with unit inference |
| `js/trend.js` | Frame trends: per-frame window measurements (mean, integral, …) and their chart |
| `js/dpa.js` | Double-pulse parameter extraction, a port of `double-pulse-analytics/dpa/analysis.py` (v3.5) |
| `js/plot.js` | Canvas plot: stacked panes, zoom/pan, drag-to-shift, cursors, extraction marks |
| `js/app.js` | UI: files, channels, frames, waveform list, shifts |
