#!/usr/bin/env python3
"""Génère une musique d'ambiance originale (libre de droits) pour la vidéo de démo.
Usage : python3 demo/music.py <durée_en_secondes> <sortie.wav>
Ambiance « corporate / créative » : accords La mineur – Fa – Do – Sol, arpège, basse douce, léger groove."""
import sys
import wave

import numpy as np

SR = 44100
BPM = 100
BEAT = 60 / BPM

duration = float(sys.argv[1])
out_path = sys.argv[2]
n = int(duration * SR)
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def add(buf, start_s, sig, gain, pan=0.0):
    i = int(start_s * SR)
    if i >= buf.shape[1]:
        return
    sig = sig[: buf.shape[1] - i]
    buf[0, i:i + len(sig)] += sig * gain * (1 - max(pan, 0))
    buf[1, i:i + len(sig)] += sig * gain * (1 + min(pan, 0))


def env(length, attack, decay):
    t = np.arange(length) / SR
    return np.minimum(t / max(attack, 1e-4), 1.0) * np.exp(-t / decay)


def pluck(midi, length_s):
    L = int(length_s * SR)
    t = np.arange(L) / SR
    f = hz(midi)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) + 0.12 * np.sin(2 * np.pi * 3 * f * t)
    return s * env(L, 0.004, 0.28)


def pad(midis, length_s):
    L = int(length_s * SR)
    t = np.arange(L) / SR
    s = np.zeros(L)
    for m in midis:
        for det in (-0.07, 0.0, 0.07):
            f = hz(m) * 2 ** (det / 12)
            s += np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)
    a = np.minimum(t / 0.9, 1.0)
    r = np.minimum((length_s - t) / 0.9, 1.0)
    return s * a * np.clip(r, 0, 1) / (len(midis) * 3)


def bass(midi, length_s):
    L = int(length_s * SR)
    t = np.arange(L) / SR
    f = hz(midi)
    return (np.sin(2 * np.pi * f * t) + 0.2 * np.sin(2 * np.pi * 2 * f * t)) * env(L, 0.01, 0.55)


def kick():
    L = int(0.22 * SR)
    t = np.arange(L) / SR
    f = 110 * np.exp(-t * 22) + 42
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 15)


def hat():
    L = int(0.05 * SR)
    noise = rng.standard_normal(L)
    noise = np.diff(noise, prepend=0)  # passe-haut grossier
    return noise * np.exp(-np.arange(L) / SR * 90)


# La mineur – Fa – Do – Sol (notes MIDI)
CHORDS = [
    (45, [57, 60, 64]),  # Am
    (41, [53, 57, 60]),  # F
    (48, [55, 60, 64]),  # C
    (43, [55, 59, 62]),  # G
]
bar = 4 * BEAT
dry = np.zeros((2, n))
wet = np.zeros((2, n))
k, h_ = kick(), hat()
bars = int(duration / bar) + 2
for b in range(bars):
    t0 = b * bar
    root, tones = CHORDS[b % 4]
    add(dry, t0, pad([m - 12 for m in tones], bar + 0.4), 0.22)
    for beat in range(4):
        tb = t0 + beat * BEAT
        add(dry, tb, bass(root, BEAT * 0.95), 0.30 if beat % 2 == 0 else 0.18)
        add(dry, tb, k, 0.22 if beat % 2 == 0 else 0.10)
        add(dry, tb + BEAT / 2, h_, 0.05)
    # arpège en croches (modèle 0-1-2-1-2-1-0-2)
    pattern = [0, 1, 2, 1, 2, 1, 0, 2]
    for step, idx in enumerate(pattern):
        ts = t0 + step * BEAT / 2
        note = tones[idx] + 12
        add(wet, ts, pluck(note, 0.9), 0.17 if step % 2 == 0 else 0.12, pan=-0.35 if step % 2 else 0.35)

# petit écho sur l'arpège
delay = int(BEAT * 0.75 * SR)
for rep, g in enumerate([0.45, 0.22, 0.1], start=1):
    wet[:, delay * rep:] += wet[:, : n - delay * rep][:, ::1] * g if delay * rep < n else 0

mix = dry + wet
mix /= max(np.abs(mix).max(), 1e-6)
mix *= 0.85
fade_in, fade_out = int(2.0 * SR), int(5.0 * SR)
mix[:, :fade_in] *= np.linspace(0, 1, fade_in)
mix[:, -fade_out:] *= np.linspace(1, 0, fade_out)
pcm = (mix.T * 32767).astype("<i2")
with wave.open(out_path, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f"Musique générée : {out_path} ({duration:.0f} s)")
