# Seedance input and output capabilities

The three gateways use the same public generation fields. Wallet authentication,
API-key holds, signed poll URLs and settlement timing are unchanged.

## Supported combinations

| Model | First + last frame | Reference images | Reference video/audio combinations |
| --- | --- | --- | --- |
| Seedance 1.5-pro | Yes | No | No |
| Seedance 2.0 / Fast / Mini | Yes | 1–9 | Image + video, image + audio, video + audio, or all three; 1–3 clips of each type |
| Seedance 2.5 | Yes | 1–30 | Still held pending render/cost verification |

`image_url` means a first-frame seed. For a character/style image alongside a
reference video, use `reference_image_urls`, not `image_url`. Frame seeding and
reference mode remain mutually exclusive. Seedance 2.0 audio references require
at least one reference image or video. Upstream media duration, size and content
constraints still apply; accepting a URL does not verify the remote file.

```json
{
  "model": "bytedance/seedance-2.0-fast",
  "prompt": "Use image 1 for the character and video 1 for the motion",
  "duration_seconds": 5,
  "reference_image_urls": ["https://example.com/character.png"],
  "reference_videos": [{"url": "https://example.com/motion.mp4"}],
  "input_type": "reference",
  "return_last_frame": true
}
```

POST to `/v1/videos/generations` or `/api/v1/videos/generations`. Native
`content[]` also works on these endpoints and `/v1/videos`: `reference_image`,
`reference_video`, `reference_audio`, `first_frame`, and `last_frame` roles map
to the corresponding validated flat fields. A role-less single image keeps its
existing first-frame meaning. Alternatively use `frame_images` with `frame_type`
or typed `input_references` with role `reference`. Use one media syntax per
request; conflicting aliases or media fields return 400 before payment.

## Additional output controls

| Field | Models | Values |
| --- | --- | --- |
| `bitrate_mode` | Seedance 2.x | `standard`, `high` |
| `output_format` | Seedance 2.5 | `mp4`, `mov` |
| `camera_fixed` | Seedance 1.5-pro | Boolean |
| `safety_identifier` | Seedance family | String |
| `return_last_frame` | Seedance family | Boolean |

When the upstream returns a last frame, completed `data[0]` includes
`last_frame_url` and `last_frame_backed_up`. The frame uses the same storage
backup/fallback semantics as the video. Solana starts the copy without delaying
settlement, preserving its blockhash timing. An upstream that omits the frame
produces no invented frame URL. Failover is refused when it would drop a
requested control or an asset reference.

Python uses the snake_case fields above. TypeScript uses `referenceImageUrls`,
`referenceVideos`, `referenceAudios`, `bitrateMode`, `outputFormat`, `cameraFixed`,
`safetyIdentifier`, `returnLastFrame`, and `inputType`. MCP exposes snake_case
fields and reserves the existing reference-media surcharge before payment.

## Operational limits

`R2V_ENABLED=false` still refuses NEW reference-video/audio jobs with 503.
This change does not modify deployment configuration or re-enable production.
Jobs already accepted remain pollable. Image-only references are not subject
to that operational switch.

Automatic duration (`-1`), 2.5 editing/extension task modes, 2.5 reference media,
2.5 1080p, draft/flex service tiers, callbacks, and task-list/cancel APIs remain
outside this change. The first group needs verified cost/output bounds; the
lifecycle features need a separate ownership and settlement design. Known
unsupported request controls are rejected instead of silently discarded.

New behavior is covered by local request-contract and mocked payment-lifecycle
tests. New paid upstream renders and production rollout are separate checks.
