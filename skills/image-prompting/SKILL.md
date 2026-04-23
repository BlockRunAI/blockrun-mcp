---
name: image-prompting
description: Use when generating or editing images via `blockrun_image` — especially with GPT Image 2, DALL-E 3, or Flux for posters, UI mockups, marketing assets, product shots, or anything with on-image text. Turns vague user requests ("make me a cool poster") into structured, text-accurate prompts that actually render what you asked for.
---

# Image Prompting

Most image failures are prompt failures. This skill gives the MCP agent a repeatable structure for turning any user request into a prompt that renders clean typography, preserves layout on edits, and avoids AI slop. Defaults are tuned for **GPT Image 2** (best legible text), with fallbacks for DALL-E 3, Flux, and Nano Banana.

Source of truth: fal.ai *Prompting GPT Image 2* guide. Principles transfer across models.

## Quick Decision Table

| User wants... | Model | Mode | Size | Cost |
|---|---|---|---|---|
| Poster / typography-heavy asset | `openai/gpt-image-2` | generate | `1536x1024` or `1024x1536` | ~$0.04 |
| Clean product / UI mockup | `openai/gpt-image-2` | generate | `1024x1024` | ~$0.04 |
| Photoreal / fashion / editorial | `openai/gpt-image-2` or `black-forest/flux-1.1-pro` | generate | `1024x1024`+ | $0.04–0.06 |
| Artistic / stylized / fast | `google/nano-banana` | generate | `1024x1024` | ~$0.01 |
| Edit an existing image (localized change) | `openai/gpt-image-2` | edit | match source | ~$0.04 |
| Composite from multiple refs | `openai/gpt-image-2` | edit (multi-ref) | match target | ~$0.04 |

**Valid GPT Image 2 sizes:** `1024x1024` (square), `1536x1024` (landscape ~3:2), `1024x1536` (portrait ~2:3).

## The 5-Section Prompt Framework

Write prompts as **five short blocks separated by blank lines.** This is the single biggest quality lever.

```
SCENE: where/when/background/environment, one or two lines.

SUBJECT: the main focus (who/what), described concretely.

DETAILS: materials, texture, lighting, camera angle, composition, mood,
lens feel, depth of field, surface condition. Stack concrete nouns.

USE CASE: editorial photo / product mockup / poster / UI screen / infographic / concept frame.
(This single line tells the model what kind of image to produce.)

CONSTRAINTS: what must not drift. "No extra text." "No duplicate elements."
"Preserve face." "Legible typography." Repeat these on every edit.
```

> *"The fifth slot is where most mediocre prompts fail silently. Describe the idea without bounding it and the model gets inventive in directions you will regret."* — fal.ai

## Text & Typography Rules (the #1 differentiator for GPT Image 2)

1. **Wrap literal text in quotes or ALL CAPS.** `Headline (EXACT TEXT): "Fresh and clean."`
2. **Specify** font style, weight, size, color, placement, letter-spacing.
3. **Treat text as layout, not decoration:** hero vs. sub vs. caption with hierarchy + spacing.
4. **State:** `No extra words. No duplicate text. No watermarks.`
5. **Spell difficult words letter-by-letter** if the model keeps breaking them.
6. **Mark each distinct piece of copy** with its role: `HERO:`, `SUB:`, `BOTTOM-LEFT TAG:`, `TOP BANNER:`.

## Anti-Slop Rules (visual facts > excitement)

| Bad (vague / praise-loaded) | Good (concrete visual fact) |
|---|---|
| "stunning, epic, masterpiece" | "overcast daylight, brushed aluminum, 50mm feel" |
| "minimalist brutalist luxury editorial" | "cream background, heavy black condensed sans-serif, asymmetric type block, one hero object, studio tabletop light" |
| "it should contain a boarding pass feel" | "a boarding pass lies on the tray, barcode visible, creased corner" |
| "beautiful lighting" | "incandescent work lamp spilling warm light onto wet concrete" |

**Rules:**
- **Visual facts over praise.** Replace adjectives like *gorgeous/stunning/incredible* with observable specifics.
- **Style tags need targets.** Don't just name a style — describe the artifacts that style produces.
- **Say the real thing.** If the image must contain a boarding pass, say "boarding pass."
- **Name the lens.** 35mm, 50mm, medium format. Depth of field: shallow vs. deep.
- **Name the light.** Source + quality + direction + color temperature.

## Instructions

### 1. Initialize

```python
import os
from pathlib import Path

chain_file = Path.home() / ".blockrun" / ".chain"
chain = chain_file.read_text().strip() if chain_file.exists() else "base"

if chain == "solana":
    from blockrun_llm import setup_agent_solana_wallet, ImageClient
    setup_agent_solana_wallet()
else:
    from blockrun_llm import setup_agent_wallet, ImageClient
    setup_agent_wallet()

image = ImageClient()
```

### 2. Generate from Scratch

```python
prompt = """
SCENE: A realistic roadside billboard at sunset, empty two-lane highway,
soft gradient sky from peach to lavender, a few utility poles.

SUBJECT: A product billboard for a bottled water brand. Bottle on the right
third of the frame, catching warm rim light.

DETAILS: 35mm photo feel, shallow depth of field, matte-painted billboard,
clean kerning, precise print finish.

USE CASE: Product mockup for a marketing deck, landscape 3:2.

CONSTRAINTS:
- Headline (EXACT TEXT): "Fresh and clean."
- Bold sans-serif, high contrast, centered vertically in the left half.
- No extra words. No duplicate text. No watermark.
"""

result = image.generate(
    prompt,
    model="openai/gpt-image-2",
    size="1536x1024",
    n=1,
)
print(result.data[0].url)  # URL or data URL
```

### 3. Edit: Change / Preserve / Constraints

**The golden pattern** for iterative editing — one small change per turn. Repeat the preserve list every turn.

```python
prompt = """
CHANGE: Make the light warmer — shift the sunset toward a deeper orange.
         Remove the extra chair on the left.

PRESERVE: Keep the bottle position, label text, and billboard layout exactly
          as in the source image. Keep the headline text verbatim.

CONSTRAINTS: No extra text. No duplicate elements. Same aspect ratio.
"""

# `image` arg accepts a public URL OR a data URL (data:image/png;base64,...)
result = image.edit(
    prompt,
    image="https://example.com/source.png",
    model="openai/gpt-image-2",
    size="1536x1024",
)
print(result.data[0].url)
```

**Why this works:** small atomic edits compound reliably. Giant rewrites ("redo this but nicer") drift everything.

### 4. Multi-Reference Composition

Pass multiple reference images (up to ~16) via the `edit` endpoint. Label each reference's role in the prompt so the model knows how to use it.

```python
prompt = """
COMPOSITE: Combine the three reference images as follows.
- REF 1 is the SUBJECT (the wristwatch): preserve exact dial, hands, and crown.
- REF 2 is the ENVIRONMENT (marble tabletop + window light): use as background.
- REF 3 is the STYLE REFERENCE: match its color grade and contrast.

USE CASE: E-commerce hero shot, square.

CONSTRAINTS: No extra objects. No text. Preserve watch proportions exactly.
"""

# SDK: pass primary via `image=`; additional refs via a multipart request
# (check the MCP's `blockrun_image` tool for the multi-image payload shape)
```

## Common Workflows

### Poster / social asset

Use `1536x1024` for X/Twitter, `1024x1024` for IG grid, `1024x1536` for IG story.
Put every copy element on its own labeled line in the CONSTRAINTS block. Always include
`No duplicate text. No extra words.`

### UI screen mockup

State the device, status bar, app name, screen title, each visible element with position
and state (checked, active, disabled), palette (hex-ish is fine: "deep navy accent"),
typography scale, corner radius, spacing feel.

### Product shot

Surface + light source + lens + depth of field + one hero object. Name the material
of everything in frame. Avoid "beautiful" — describe what you'd see.

### Concept/brand exploration

Generate 3–4 variants with the same 5-section skeleton but swap only the DETAILS
block (palette, lens, material). Keep SCENE/SUBJECT/USE CASE/CONSTRAINTS identical
so you're actually comparing one variable.

## Prompt Template (copy-paste and fill in)

```
SCENE: <where/when/background>

SUBJECT: <main focus, concrete nouns>

DETAILS: <materials, texture, lighting (source + quality + color),
         camera angle, lens feel, depth of field, composition, mood>

USE CASE: <poster | UI screen | product shot | editorial photo | concept frame>

CONSTRAINTS:
- HERO (EXACT TEXT): "<verbatim copy>"
- SUB: "<verbatim copy>"
- <other copy with role labels>
- <typography rules: font style, weight, spacing, hierarchy>
- No extra words. No duplicate text. No watermark.
- <anything that must not drift: face, layout, aspect ratio>
```

## Three Operating Modes (at a glance)

| Mode | When | Endpoint | Pattern |
|---|---|---|---|
| Generate | From scratch | `/v1/images/generations` | 5-section framework |
| Edit | One image, localized change | `/v1/images/image2image` | Change / Preserve / Constraints |
| Combine | Multi-image composition | `/v1/images/image2image` (multi-ref) | Labeled refs (SUBJECT / ENV / STYLE) |

## Notes & Gotchas

- **GPT Image 2 is currently the best for legible on-image text.** For artistic prompts with no copy, Nano Banana is 4× cheaper and often prettier.
- **Response shape:** `result.data[0].url` is either an HTTPS URL or a `data:image/...;base64,...` string. Save via `urllib.request.urlretrieve` for URLs or `base64.b64decode(item.b64_json)` for b64 payloads.
- **Aspect ratio:** only the three sizes above are valid for GPT Image 2. If the user asks for 16:9, use `1536x1024` — it reads as landscape on X/Twitter without cropping.
- **Iterative edits drift.** Repeat the PRESERVE list every turn, even when it feels redundant.
- **If text keeps breaking:** shorten it, spell difficult words, and move it to a dedicated `CONSTRAINTS` line marked `(EXACT TEXT)`.
- **Never use** words like *amazing, stunning, masterpiece, ultra-detailed, 8k, trending on artstation* — they waste tokens and pull toward generic AI-slop aesthetics.

## Requirements

- BlockRun SDK: `pip install blockrun-llm`
- USDC wallet funded (`ImageClient().get_wallet_address()`; `setup_agent_wallet().get_balance()`)
- For `edit` / multi-ref: source images must be reachable by a public URL or passed as a data URL

## Reference

- fal.ai — [Prompting GPT Image 2](https://fal.ai/learn/tools/prompting-gpt-image-2) (primary source)
- BlockRun image models: `openai/gpt-image-2`, `openai/gpt-image-1`, `openai/dall-e-3`, `google/nano-banana`, `google/nano-banana-pro`, `black-forest/flux-1.1-pro`, `zai/cogview-4`, `xai/grok-imagine-image`, `xai/grok-imagine-image-pro`
