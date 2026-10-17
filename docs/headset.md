# Headsets and WebXR

RealHermes runs in the desktop simulator anywhere and enters immersive sessions where the browser supports WebXR. It was built and exercised on a Valve Steam Frame, using the headset's Chromium-based browser and OpenXR runtime. Other WebXR browsers and headsets should work for the basics but have not been tested.

## Secure context first

Microphone access and WebXR sessions are available only in a secure context: an `https://` origin, or a loopback origin such as `http://127.0.0.1`. On a desktop, the default URLs are already loopback. On a headset, use the reverse SSH tunnel from [production.md](production.md#connecting-a-headset-over-ssh) and open `http://127.0.0.1:<port>` on the headset itself. A LAN address such as `http://<host-ip>:5173` is not a secure context, and RealHermes does not listen on the LAN anyway. HTTPS hosting is not provided.

## Entering and leaving a session

**Enter AR** and **Enter VR** appear in the stage footer. Each is enabled only when the browser reports support for that session type in a secure context; otherwise the page says that AR/VR is unavailable and the desktop simulator keeps working. A session starts only when you press one of these buttons. Leave it with the headset's or browser's own controls. In AR, 2x4 appears ahead of the starting position, using the same height and distance as the desktop sliders. There is no hit testing and there are no persistent anchors.

## Controls

| Action | Desktop simulator | XR controllers |
| --- | --- | --- |
| Talk | **Start microphone** / **Stop microphone**, or hold the left mouse button on the canvas | Hold the right controller trigger while not aiming at the artifact panel |
| Send | Release (or stop the microphone); recordings stop after 60 s | Release the trigger |
| Type | Composer and **Send** | Not available; use voice |
| Look around | Drag to orbit, scroll to zoom | Your head |
| Place 2x4 | Height and distance sliders, **Reset placement** | Uses the desktop placement |
| Press a panel control | Click it | Aim the trigger at it and press |
| Move the panel | Drag its surface, title or page with the primary button | Squeeze the grip while aiming at any part of the panel, or with the controller held against it; or drag the page with the trigger |
| Resize the panel | Two pointers at once (touch), or **Smaller** / **Larger** | **Smaller** / **Larger** |

Only the right controller's trigger is push-to-talk. Left controllers, gaze and screen-tap inputs are ignored for talking. A trigger aimed at the panel presses its controls or drags it instead of starting voice. A hold that began elsewhere still ends when you release over the panel. While held, the panel follows your hand, not the end of the ray. It stays upright and unscaled, keeps within its placement bounds (no closer than a reading distance of about 0.45 m in front of you), and stays where you release it.

## What 2x4 can see

When an answer depends on what you are looking at, Hermes calls the bundled `steam_frame_capture` tool ([configuration.md](configuration.md#seeing-what-the-wearer-sees)). On the Steam Frame it records one second of the panel view with Framecorder over SSH and keeps one frame: what you see in the headset, including the real-world passthrough scene when passthrough is active. Hermes then inspects that still with its vision tool. The headset must be awake with SteamVR running; otherwise the tool reports that the view is unavailable instead of describing an old frame.

## Steam Frame notes

- **Microphone and standby.** While SteamVR has the headset in standby, its microphones deliver digital silence. RealHermes detects that before uploading and shows "Microphone returned digital silence. Wear the headset (standby mutes the Frame microphone) and speak while holding the trigger."
- **Canvas size.** In the headset browser's default layout, the simulator canvas measured 641×543 CSS pixels, with the stage heading and the artifact footer covering its top and bottom edges. The artifact panel and its two control rows are sized and bounded to stay visible in that canvas; tests check this layout.
- **Controller events.** The browser delivers the trigger as WebXR `select` and the grip as `squeeze` events, with poses only through `XRFrame.getPose`. The artifact grab and push-to-talk logic is built and tested against exactly that.

## Limits

- No lip sync and no animations other than the bundled idle clip.
- No text entry inside immersive sessions.
- One artifact panel at a time; PDF pages are images, without selectable text or working links.
- No AR hit testing, plane detection or anchors.
- In-world text may need fonts from `cdn.jsdelivr.net`; offline, labels may not render.
- The 2x4 model is about 38 MB; the first load on a headset can take a while.
