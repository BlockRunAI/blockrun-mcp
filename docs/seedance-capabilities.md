# Seedance input and output capabilities

What `blockrun_video` accepts, which models take it, which RAIL serves it, and
what it costs. Written for this MCP server; the gateway's own request shapes,
the SDK field names and the deployment switches live in their own repos.

## Reference media is account-rail only

Reference inputs (`reference_image_urls`, `reference_videos`,
`reference_audios`) are served **only** by `api.blockrun.ai` — the account rail,
reached by setting `BLOCKRUN_API_KEY`.

Both wallet gateways refuse them with a `400` **before** issuing a quote
(blockrun#728, blockrun-sol#374; live-probed on `blockrun.ai` and
`sol.blockrun.ai` on 2026-09-26):

```
{"error":"reference media is not available on this gateway",
 "message":"Seedance reference media (reference_image_urls) is served only by
            api.blockrun.ai. ..."}
```

`blockrun_video` refuses them client-side on the wallet rails rather than
forwarding a request that cannot succeed, so no payment is taken and no DNS
lookup is spent on the reference URLs. Frame seeding (`image_url`,
`last_frame_url`) is unaffected and works on every rail.

## Supported combinations

| Model | First + last frame | Reference images | Reference video/audio |
| --- | --- | --- | --- |
| Seedance 1.5-pro | Yes | No | No |
| Seedance 2.0 / 2.0-fast / 2.0-mini | Yes | 1–9 | Image + video, image + audio, video + audio, or all three; 1–3 clips of each type |
| Seedance 2.5 | Yes | 1–30 | No |

Seedance 2.5 takes reference **images** but no reference clips — the gateway
registry carries `supportsReferenceImages: true` with
`supportsReferenceMedia: false` for it, and the tool's guard matches.

`image_url` means a first-frame seed. For a character or style image alongside
a reference video, use `reference_image_urls`, not `image_url`. Frame seeding
and reference mode are mutually exclusive. Reference audio on the 2.0 family
requires at least one reference image or video. Upstream duration, size and
content constraints still apply; accepting a URL does not verify the remote
file.

```json
{
  "model": "bytedance/seedance-2.0-mini",
  "prompt": "Use image 1 for the character and video 1 for the motion",
  "duration_seconds": 5,
  "reference_image_urls": ["https://example.com/character.png"],
  "reference_videos": [{"url": "https://example.com/motion.mp4"}],
  "return_last_frame": true
}
```

`input_type` is optional and is derived from the inputs; passing a value that
disagrees with them is rejected.

## What reference media costs

Reference **clips** are billed **per reference second**, not per clip — measured
against token360 on 2026-09-23 (blockrun#730): a reference second costs what an
output second costs (~21,600 tokens against 21,780), with no per-clip
component. Audio counts at 0.3x video.

The caller sends a URL and never declares the clip's length, so the gateway
quotes **every clip at the model's 15.2s ceiling** and this tool reserves the
same. Consequences worth knowing before you call:

| Request | Reserved |
| --- | --- |
| seedance-2.0-mini, 5s output, no references | ~$0.40 |
| seedance-2.0-mini, 5s output, 1 reference video | ~$1.61 |
| seedance-2.0-mini, 4s output, 3 videos + 3 audios | ~$5.03 |
| seedance-2.0, 5s output, 3 videos + 3 audios | ~$14.54 |

A single reference clip therefore costs more than the render it conditions.
`bytedance/seedance-2.0-mini` takes the same reference inputs as
`bytedance/seedance-2.0` at roughly a third of the rate — prefer it unless you
need 4K.

Reference **images** carry no surcharge: the gateway's price formula takes
reference video and audio seconds only, and on Seedance the image-to-video and
text-to-video per-second rates are equal.

The account rail bills when the gateway **accepts** the job, and issues no 402,
so the reserve above is the only pre-payment control. Check
`blockrun_wallet action:"report"` before a large reference job.

## Additional output controls

| Field | Models | Values |
| --- | --- | --- |
| `bitrate_mode` | Seedance 2.x | `standard`, `high` |
| `output_format` | Seedance 2.5 | `mp4`, `mov` |
| `camera_fixed` | Seedance 1.5-pro | Boolean |
| `seed` | Seedance 1.5-pro | 0 – 2147483647 |
| `safety_identifier` | Seedance | Opaque end-user id, ≤128 chars — not a content filter, and not a place for personal data |
| `watermark` | Seedance | Boolean, default off |
| `return_last_frame` | Seedance | Boolean |

With `return_last_frame`, a completed response carries `last_frame_url` in both
the text output and `structuredContent`, plus `last_frame_backed_up` when the
gateway reports it. The frame uses the same storage backup semantics as the
video. An upstream that omits the frame produces no invented URL.

## Not in scope

Automatic duration (`-1`), 2.5 editing/extension task modes, 2.5 1080p,
draft/flex service tiers, callbacks, and task-list/cancel APIs are not exposed.
The first group needs verified cost/output bounds; the lifecycle features need
a separate ownership and settlement design. Unsupported request controls are
rejected before payment rather than silently discarded.

Reference-video/audio jobs are additionally subject to the gateway's own
`R2V_ENABLED` operational switch, which answers `503` when off. That is
deployment state this repo neither reads nor changes. Image-only references are
not subject to it.

New behaviour is covered by `test/video-reference-media.test.ts` (rail
availability, per-guard refusals, reserve arithmetic, SSRF across the arrays).
No paid upstream renders were performed; run a small paid smoke test before
relying on a new combination in production.
