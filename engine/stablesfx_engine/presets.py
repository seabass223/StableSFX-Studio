"""Built-in game SFX presets + user presets (``~/.stablesfx/presets.json``).

Durations follow the upstream SFX guidance: impacts/one-shots 1-3 s, actions 3-6 s,
ambiences 6-15 s. Prompts describe source, action, decay and recording character.
"""

from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path

from . import paths
from .config import atomic_write_json
from .schema import GenerateParams, Preset

_BUILTIN: list[tuple[str, str, str, float, int]] = [
    # (category, name, prompt, duration, variations)
    ("UI", "Menu Click", "short clean UI button click, soft plastic tick, dry, close mic, game menu", 0.5, 6),
    ("UI", "Confirm Chime", "bright positive UI confirm chime, two rising bell tones, clean digital, short tail", 1.2, 4),
    ("UI", "Error Buzz", "short negative UI error buzz, low digital square tone, dry, game interface", 0.8, 4),
    ("UI", "Notification Pop", "soft bubbly notification pop, rounded synth blip, quick decay", 0.6, 6),
    ("Pickups", "Coin Pickup", "retro arcade coin pickup, bright metallic ding, fast upward sparkle, 8-bit flavor", 0.8, 6),
    ("Pickups", "Power-Up", "arcade power-up sound, rising synth sweep with sparkles, energetic, clean", 1.8, 4),
    ("Pickups", "Health Pickup", "magical health pickup, warm shimmering chime, gentle rising whoosh", 1.5, 4),
    ("Weapons", "Laser Blast", "futuristic laser blast, sharp energy pulse, stereo movement, arcade style", 1.2, 6),
    ("Weapons", "Pistol Shot", "single pistol gunshot, sharp crack, short outdoor reverb tail, close perspective", 1.5, 6),
    ("Weapons", "Sword Swing", "fast sword swing whoosh, metallic blade cutting air, close mic, no impact", 0.9, 8),
    ("Weapons", "Sword Clash", "two steel swords clashing, bright metallic ring, short resonant decay", 1.5, 6),
    ("Weapons", "Bow Release", "wooden bow string release and arrow flight whoosh, close, dry", 1.2, 6),
    ("Impacts", "Punch Hit", "heavy body punch impact, thick low thud, cloth movement, close and dry", 0.8, 8),
    ("Impacts", "Wood Crate Break", "wooden crate smashing apart, splintering planks, debris falling, medium room", 2.0, 4),
    ("Impacts", "Metal Impact", "heavy metal object hitting concrete floor, loud clang, ringing decay", 2.0, 4),
    ("Explosions", "Small Explosion", "small explosion, punchy blast, crackling debris, short rumble tail", 2.5, 4),
    ("Explosions", "Big Explosion", "massive cinematic explosion, deep sub boom, rolling rumble, debris rain", 5.0, 3),
    ("Movement", "Whoosh", "fast airy whoosh pass-by, smooth swish, stereo movement", 1.0, 6),
    ("Movement", "Footsteps Gravel", "footsteps walking on gravel, steady pace, boots, close perspective, outdoor", 4.0, 4),
    ("Movement", "Jump Land", "character jump and landing on dirt, cloth rustle, soft thump", 1.0, 6),
    ("Magic", "Spell Cast", "magic spell cast, sparkling energy swirl, rising shimmer, mystical burst", 2.0, 4),
    ("Magic", "Fireball", "fireball whoosh and ignition, roaring flame burst, crackling fire tail", 2.5, 4),
    ("Magic", "Ice Shatter", "ice spell shattering, crystalline crack, glassy tinkling debris", 2.0, 4),
    ("Magic", "Teleport", "sci-fi teleport, reversed swell into bright zap, airy shimmer tail", 1.8, 4),
    ("Creatures", "Monster Growl", "large monster growl, deep guttural rumble, wet throat texture, close", 3.0, 4),
    ("Creatures", "Small Creature Squeak", "small cute creature squeak, high chirp, playful, dry", 0.8, 6),
    ("Creatures", "Zombie Moan", "zombie moan, low raspy groan, slow, eerie, close mic", 3.0, 4),
    ("Vehicles", "Engine Start", "car engine starting, starter crank then idle rumble, close perspective", 4.0, 3),
    ("Vehicles", "Spaceship Pass-By", "sci-fi spaceship fly-by, deep engine hum with doppler pass, stereo sweep", 5.0, 3),
    ("Ambience", "Forest Night", "night forest ambience, crickets, distant owl, light wind in trees, no music", 12.0, 2),
    ("Ambience", "Dungeon Drips", "dark dungeon ambience, water drips echoing, low distant rumble, cavernous", 12.0, 2),
    ("Ambience", "Rain on Window", "steady rain on a window, soft patter, distant thunder, indoor perspective", 12.0, 2),
    ("Ambience", "Sci-Fi Hum", "spaceship interior ambience, low machinery hum, soft electronic beeps", 12.0, 2),
]


def builtin_presets() -> list[Preset]:
    out = []
    for category, name, prompt, duration, variations in _BUILTIN:
        out.append(Preset(
            id=f"builtin:{category.lower()}:{name.lower().replace(' ', '-')}",
            name=name, category=category, builtin=True,
            params=GenerateParams(prompt=prompt, duration=duration),
            variations=variations,
        ))
    return out


class PresetStore:
    def __init__(self, path: Path | None = None):
        self.path = path or paths.presets_json()
        self._lock = threading.Lock()

    def _user(self) -> list[Preset]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return [Preset.model_validate(p) for p in raw]
        except (OSError, ValueError):
            return []

    def all(self) -> list[Preset]:
        return builtin_presets() + self._user()

    def get(self, preset_id_or_name: str) -> Preset | None:
        key = preset_id_or_name.lower()
        for p in self.all():
            if p.id.lower() == key or p.name.lower() == key:
                return p
        return None

    def save(self, preset: Preset) -> Preset:
        with self._lock:
            users = self._user()
            if not preset.id or preset.id.startswith("builtin:"):
                preset = preset.model_copy(update={"id": f"user:{uuid.uuid4().hex[:10]}", "builtin": False})
            users = [p for p in users if p.id != preset.id] + [preset.model_copy(update={"builtin": False})]
            atomic_write_json(self.path, [p.model_dump() for p in users])
            return preset

    def delete(self, preset_id: str) -> None:
        with self._lock:
            users = [p for p in self._user() if p.id != preset_id]
            atomic_write_json(self.path, [p.model_dump() for p in users])
