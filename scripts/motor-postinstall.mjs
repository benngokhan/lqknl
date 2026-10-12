/**
 * BİLGİ DOZU marka motoru için python bağımlılıklarını kur.
 * Bu adım ASLA build'i kırmaz: python/pip yoksa ya da kurulum patlarsa sessizce geçer;
 * produce tarafındaki renderWithMotor yakalayıcısı zaten TS/ffmpeg merdivenine düşer.
 */
import { spawnSync } from "node:child_process";

const wheels = ["pillow", "numpy", "imageio-ffmpeg"];

for (const py of ["python3", "python"]) {
  const probe = spawnSync(py, ["-c", "import PIL, numpy, imageio_ffmpeg"], { stdio: "ignore" });
  if (probe.status === 0) {
    console.log(`[motor] ${py}: pillow/numpy/imageio-ffmpeg hazır`);
    process.exit(0);
  }
  const pip = spawnSync(py, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-cache-dir", ...wheels], { stdio: "ignore", timeout: 240_000 });
  const verify = spawnSync(py, ["-c", "import PIL, numpy, imageio_ffmpeg"], { stdio: "ignore" });
  if (pip.status === 0 && verify.status === 0) {
    console.log(`[motor] ${py} ile bağımlılıklar kuruldu (pillow/numpy/imageio-ffmpeg)`);
    process.exit(0);
  }
}

console.log("[motor] python3/pip bulunamadı ya da kurulum başarısız — marka motoru devre dışı, TS/ffmpeg yedeği kullanılacak (bilinçli fallback)");
process.exit(0);
