"""Measure the actual Open Note Block Studio vanilla instrument samples.

Requires PyAV and NumPy. Results are printed as JSON so mapping decisions can
be reviewed and reproduced instead of being based only on instrument names.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import av
import numpy as np


FILES = [
    "harp.ogg", "dbass.ogg", "bdrum.ogg", "sdrum.ogg", "click.ogg", "guitar.ogg",
    "flute.ogg", "bell.ogg", "icechime.ogg", "xylobone.ogg", "iron_xylophone.ogg",
    "cow_bell.ogg", "didgeridoo.ogg", "bit.ogg", "banjo.ogg", "pling.ogg",
]


def decode(path: Path) -> tuple[np.ndarray, int]:
    container = av.open(str(path))
    stream = container.streams.audio[0]
    chunks = []
    for frame in container.decode(stream):
        data = frame.to_ndarray().astype(np.float64)
        if data.ndim == 2:
            data = data.mean(axis=0)
        chunks.append(data.reshape(-1))
    return np.concatenate(chunks), int(stream.rate)


def estimate_f0(signal: np.ndarray, sample_rate: int) -> float | None:
    start = min(len(signal), int(sample_rate * 0.04))
    stop = min(len(signal), start + int(sample_rate * 0.5))
    segment = signal[start:stop]
    if len(segment) < 1024:
        return None
    segment = (segment - segment.mean()) * np.hanning(len(segment))
    size = 1 << math.ceil(math.log2(len(segment) * 2 - 1))
    spectrum = np.fft.rfft(segment, size)
    correlation = np.fft.irfft(spectrum * spectrum.conjugate(), size)[: len(segment)]
    low = max(1, sample_rate // 2000)
    high = min(len(correlation), sample_rate // 40)
    lag = low + int(np.argmax(correlation[low:high]))
    confidence = correlation[lag] / max(correlation[0], 1e-12)
    return sample_rate / lag if confidence >= 0.08 else None


def analyze(path: Path, index: int) -> dict[str, object]:
    signal, sample_rate = decode(path)
    signal = signal / max(np.max(np.abs(signal)), 1e-12)
    window = max(1, int(sample_rate * 0.02))
    hop = max(1, int(sample_rate * 0.01))
    rms = np.array([
        math.sqrt(float(np.mean(signal[pos:pos + window] ** 2)))
        for pos in range(0, max(1, len(signal) - window + 1), hop)
    ])
    peak_frame = int(np.argmax(rms))
    energy = signal ** 2
    cumulative = np.cumsum(energy)
    effective_index = int(np.searchsorted(cumulative, cumulative[-1] * 0.95)) if cumulative[-1] else 0

    spectral = signal[: min(len(signal), sample_rate)]
    spectral = spectral * np.hanning(len(spectral))
    magnitude = np.abs(np.fft.rfft(spectral)) + 1e-12
    frequencies = np.fft.rfftfreq(len(spectral), 1 / sample_rate)
    centroid = float(np.sum(frequencies * magnitude) / np.sum(magnitude))
    flatness = float(np.exp(np.mean(np.log(magnitude))) / np.mean(magnitude))
    cumulative_spectrum = np.cumsum(magnitude)
    rolloff = float(frequencies[np.searchsorted(cumulative_spectrum, cumulative_spectrum[-1] * 0.85)])
    zcr = float(np.mean(np.abs(np.diff(np.signbit(signal)))))
    early = int(sample_rate * 0.08)
    transient_ratio = float(np.sum(energy[:early]) / max(np.sum(energy), 1e-12))
    f0 = estimate_f0(signal, sample_rate)
    return {
        "index": index,
        "file": path.name,
        "duration_ms": round(len(signal) * 1000 / sample_rate, 1),
        "attack_ms": round(peak_frame * hop * 1000 / sample_rate, 1),
        "energy95_ms": round(effective_index * 1000 / sample_rate, 1),
        "centroid_hz": round(centroid, 1),
        "rolloff85_hz": round(rolloff, 1),
        "flatness": round(flatness, 5),
        "zero_crossing_rate": round(zcr, 5),
        "first80ms_energy": round(transient_ratio, 4),
        "estimated_f0_hz": round(f0, 2) if f0 else None,
    }


def main() -> None:
    root = Path(sys.argv[1])
    results = [analyze(root / filename, index) for index, filename in enumerate(FILES)]
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
