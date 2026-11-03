# Final Fantasy Wiki: naming guide

## File names

```
<Subject> from <Release>[ <Version>] <Type>[ <N>].<ext>
<Quest or chapter> from <Release>[ <Version>][ <N>].<ext>
<Release title>[ <more>] <Type>[ <N>].<ext>
```

The last form is only for a subject that is itself a release missing from `get_vocabulary`, so the name already says what it's from: `Final Fantasy VII Technical Demo for PS3 still.jpg`. Start with the release's full title. Anything else uses the first two forms.

Get release and version tokens from `get_vocabulary`; never invent one. Check every name with `validate_name` before planning.

### Subject

- Name the subject **as that release's translation spells it**, not as the current article title does: `Aeris Gainsborough` in FFVII, `Aerith Gainsborough` in FFVII Remake. A release's party member page (its title uses the first name only) shows the translated spelling.
- A descriptor can follow the name when it tells files apart, such as an outfit: `Tifa original attire from Advent Children promo render`.
- For screenshots, the subject is what the shot is about: an ability, event or place (`Omnislash from FFVII gameplay.png`). A character is the subject only when the shot shows nothing but that character.
- Use the quest form for a multi-subject shot of a quest or chapter: `Infiltration from FFVII Remake.jpg`.

### Version

- Leave the version out for version-neutral releases (FFVII, FFVII Remake, Advent Children, FFXIV and others); `get_vocabulary` lists no versions for them.
- Otherwise include the version the image comes from (`FFVI SNES`, `FFVI GBA`, `FFVI Pixel Remaster`). If you can't tell which, ask.

### Type

| Type | Use it for |
|---|---|
| `render` | A rendered 3D character or object. `battle render` in battle, `field render` out in gameplay (towns, the world map). |
| `promo render` | A render Square Enix supplied to promote the game. An in-game model rendered by someone else is a plain `render`. Sometimes can be more specific, such as `bust render`. |
| `model` | An in-game 3D model (`battle model`, `field model`). |
| `sprite` | 2D games use sprites, not models or renders (`battle sprite`, `field sprite`). Characters from 2D games are almost always sprites: `Terra Branford from FFVI sprite.png`. Renders are rare there (for FFVI, only the PS version's CG cutscenes have them). |
| `menu portrait` | Many games use portraits depicting a character in dialogue. A "menu portrait" can fill this. For games where the menu portrait is simply the reuse of a render from elsewhere, the render name suffices. |
| `still` | A frame from a video that isn't the game itself, such as a tech demo: `Final Fantasy VII Technical Demo for PS3 still.jpg`. |
| `gameplay` | A screenshot of gameplay. |
| `cutscene` | A screenshot of a cutscene. |
| `dialogue` | A screenshot of in-game dialogue, during gameplay. |
| `concept art` | Concept art. |

A more specific type ends in one of these (`battle render`, `field sprite`). There is no `screen` type.

### Numbers

Don't add numbers; planning does. A file that is alone has no number; files whose names would otherwise be the same, even if only their extensions differ, are numbered as a set from 1. If two files would only differ by extension, look at why: they may be duplicates (delete one), or something tells them apart that belongs in the subject or type.

## Old names say little

Names like `Tifa-Hot.jpg` are common. Look at the image (`get_file_info` with `thumbnails`), its description page and categories, and where and how pages use it (captions, sections) before naming it: `Tifa-Hot.jpg` → `Tifa original attire from Advent Children promo render.jpg`.

## Categories

```
<Kind> from <Release title>      e.g. Character images from Final Fantasy VII
<Kind> for <Release title>       e.g. Concept art for Final Fantasy VII
```

New category pages start with `{{category |name=… |contains=all image |namespace=file |related=… }}`, then their parent categories, like the FFVII Remake categories. Give `related` (e.g. `[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']]`). Model a new category on a correctly named sibling when one exists.
