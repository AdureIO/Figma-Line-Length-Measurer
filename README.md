# Figma Line Length Measurer

A Figma plugin that measures vector line/path length and places an aligned label on the line.

It supports straight and curved vector segments, per-frame/group scale overrides, persistent tracked lines, and color modes for fast visual differentiation.

## Features

- Measures selected vector paths and shows the result as `cm`, `m`, or `km`.
- Places labels at the true 50% path midpoint and aligns them to line direction.
- Persists settings and tracked lines in the Figma document via plugin data.
- Supports global scale (`px/cm`) plus local scale overrides on frame/group/section containers.
- Auto-updates labels when tracked geometry changes.
- Offers color modes:
    - `auto-dark` palette
    - `auto-light` palette
    - manual line/label colors

## Project Structure

- `manifest.json` - Figma plugin manifest
- `code.js` - plugin controller/runtime logic
- `ui.html` - plugin UI (tabs: Measure, Calibrate, Settings)
- `icon.svg` / `thumbnail.svg` - plugin assets

## Run Locally in Figma

1. In Figma Desktop, open **Plugins > Development > Import plugin from manifest...**
2. Select this project's `manifest.json`.
3. Run the plugin from **Plugins > Development > Cable Length Measurer**.

## How to Use

1. **Calibrate scale**
    - Draw/select one reference vector with a known real-world length.
    - Open the **Calibrate** tab and run calibration to compute `px/cm`.
2. **Measure lines**
    - Select one or more vector lines.
    - Open the **Measure** tab and click measure.
3. **Optional settings**
    - Switch color mode (`auto-dark`, `auto-light`, or manual).
    - Adjust label font size.
    - Use **Apply settings to all lines** to refresh tracked lines.
4. **Scale overrides**
    - Select a frame/group/section and set a node scale in the **Calibrate** tab.
    - Lines inside that container use the nearest parent override before global scale.

## Notes

- The plugin currently targets Figma editor type (`figma`) only.
- Network access is disabled (`allowedDomains: ["none"]`).
- Labels use the `Inter Bold` font.

## License

This project is licensed under the MIT License. See `LICENSE`.
