# 777 Flight Deck

A Boeing 777-300ER flight simulator that runs in the browser, with no install and no build step.

- **Flight physics:** 6-DOF rigid-body model of the 777-300ER with GE90-115B engines, landing gear, brakes and autobrake. The fly-by-wire uses the C*U pitch law with envelope protections.
- **Glass cockpit:** PFD, ND, upper and lower EICAS (synoptic pages), standby instrument and EFIS control panel.
- **Autoflight:** autopilot, flight director and autothrottle with LNAV/VNAV, FLCH, V/S, ILS approach and autoland, plus the MCP and a CDU/FMC.
- **Systems:** electrical, hydraulics, fuel, APU, engine start, EICAS alerts, GPWS callouts and synthesized sound.
- **World:** CesiumJS globe. Without a key it shows ESRI satellite imagery and terrain; with a key it uses Google Photorealistic 3D Tiles.
- **Input:** keyboard, gamepad and touch (iPad).

## Run it

Live: GitHub Pages (see the repo's About section).

To run it locally, ES modules need a web server:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

### Google Earth look (optional)

Create a Google Cloud API key with the **Map Tiles API** enabled and enter it in the start menu under *Scenery → Google 3D*. The key is stored only in your browser.

## Controls (keyboard)

| Key | Action |
|---|---|
| Arrow keys | Pitch and roll (↓ = pull) |
| Z / X | Rudder |
| PageUp / PageDown, F1 / F4 | Thrust (F4 = full, F1 = idle) |
| F6 / F7 | Flaps up / down |
| G | Gear |
| B or `.` | Brakes; P = parking brake |
| A | Autopilot; Shift+A = autothrottle |
| T | TO/GA |
| C / V | Cycle view / show or hide the panel |
| 1–4 | Overhead / pedestal / CDU / lower EICAS |
| Esc / Space | Menu / pause |

The full key list is in the start menu under *KEYS*.

## Structure

`src/physics` flight dynamics · `src/systems` autopilot, FMC, aircraft systems, alerts · `src/avionics` displays and CDU ·
`src/cockpit` MCP, overhead, pedestal · `src/world` globe, model, cameras, airports · `src/input` keyboard, gamepad, touch ·
`docs/` research and module documentation · `tests/` Node tests (`node tests/physics.test.mjs` and others).

## Credits

- 777 3D model: Flightradar24 fr24-3d-models (GPLv2), loaded at runtime.
- Globe: CesiumJS (Apache 2.0). Imagery and terrain: Esri; Google Photorealistic 3D Tiles with your own key.
- Runway data: OurAirports (public domain).

This is not an approved training device. The aircraft data are estimates from public sources.
