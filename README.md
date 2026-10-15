# Hue Deck

Philips Hue lights from the PC: every room and zone with an on/off switch and a brightness slider, its
scenes as colored buttons, and each light with its own switch, brightness and color.

**Shortcuts**: right-click any room, scene or light (or press ⋯) and choose **Make a shortcut…**. Pick
what a click does (switch on and off, always on, always off; for a scene: on, or on and a second click
switches the room off) and where it goes (Desktop, Start menu, or any folder). Each shortcut gets an
icon in the colors of its scene or room, and works without opening Hue Deck.

- Windows: `HueDeck-Setup.exe` from the Releases page (installs for you only, no admin).
- Linux Mint: `HueDeck.deb` or `HueDeck.AppImage`.

The first start finds the bridge on your network and asks you to press its round button. The bridge's
address and the key it gives Hue Deck stay on your computer (`%LOCALAPPDATA%\HueDeck\config.json`,
on Linux `~/.config/HueDeck/config.json`); they are never part of this repo.

Tap the moon for light/dark; hold it for the theme colors (the same as Markpad's).

## Building

`npm ci && node build.mjs` makes `dist/index.html`; `cd desktop && npx tauri build` makes the app.
Every push to `main` builds Windows and Linux on GitHub (`.github/workflows/build.yml`).

Opened in a plain browser, the page has no way to the bridge; tests hand it a pretend one
(`window.__hueFake`).
