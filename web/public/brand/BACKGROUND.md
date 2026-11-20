# Background image

The web UI uses one background illustration (dark red anime scene: blood-red moon, oni demon, torii gate, falling petals).

- **File name and location (exact):** `web/public/brand/oni-bg.png`
- **Format:** PNG. A JPG or WebP also works if you change the `url("/brand/oni-bg.png")` in `web/app/globals.css` to the new file name.
- **Size:** about 1920×1080 (16:9), under 400 KB. Re-compress at quality 70 to 80 if it is bigger.

## How it is used

`web/app/globals.css` paints the `body` with, top to bottom: a dark overlay (`rgba(5,5,7,.50)` to `.70`), the image (`cover`, centred, fixed), then a CSS gradient (red moon glow at the top centre over near-black).

If the file is missing, the image layer paints nothing and the gradient shows. The layout is not affected.

## After saving the file

Restart the web dev server and press Ctrl+Shift+R. For a static export, run `bun run --cwd web build` again.
