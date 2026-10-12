#!/usr/bin/env bash
# MİRA × BİLGİ DOZU MOTOR — self-host kurulumu
# Python bağımlılıkları kurdurur; ffmpeg imageio-ffmpeg üzerinden gelir.
set -e
(pip3 install --quiet pillow numpy imageio-ffmpeg 2>/dev/null \
  || python3 -m pip install --quiet pillow numpy imageio-ffmpeg) \
  && python3 -c "import PIL, numpy, imageio_ffmpeg; print('motor bağımlılıkları hazır ✔')" \
  || echo "UYARI: bağımlılık kurulumu başarısız; TS/ffmpeg merdivenine düşülür (sistem durmaz)."
