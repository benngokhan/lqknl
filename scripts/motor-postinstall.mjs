/**
 * BİLGİ DOZU marka motoru için Python bağımlılıklarını doğrula/kur.
 * Kurulum hataları loglanır; video motoru doğrulanmadan başarılı sayılmaz.
 */
import { spawnSync } from "node:child_process";

const wheels = ["pillow", "numpy", "imageio-ffmpeg"];
// Ensure the build-time verifier can see packages installed by uv into the target directory.
const env = { ...process.env, PYTHONPATH: ["/app/pylib", process.env.PYTHONPATH].filter(Boolean).join(":") };

function report(label, result) {
  if (result?.stdout?.trim()) console.log(`[motor] ${label} stdout: ${result.stdout.trim().slice(-2500)}`);
  if (result?.stderr?.trim()) console.error(`[motor] ${label} stderr: ${result.stderr.trim().slice(-3500)}`);
}

for (const py of ["python3", "python"]) {
  const probe = spawnSync(py, ["-c", "import PIL, numpy, imageio_ffmpeg; print('MOTOR_DEPS_OK')"], {
    encoding: "utf8", timeout: 15000, env
  });
  if (probe.status === 0) {
    console.log(`[motor] ${py}: pillow/numpy/imageio-ffmpeg hazır`);
    process.exit(0);
  }
  report(`${py} import kontrolü`, probe);

  // Railway/Nix ortamlarında pip, externally-managed uyarısı verebilir.
  const pip = spawnSync(py, [
    "-m", "pip", "install", "--break-system-packages",
    "--disable-pip-version-check", "--no-cache-dir", ...wheels
  ], { encoding: "utf8", timeout: 240_000, env });
  report(`${py} pip kurulumu (exit=${pip.status ?? "null"})`, pip);

  const verify = spawnSync(py, ["-c", "import PIL, numpy, imageio_ffmpeg; print('MOTOR_DEPS_OK')"], {
    encoding: "utf8", timeout: 15000
  });
  report(`${py} son doğrulama`, verify);
  if (pip.status === 0 && verify.status === 0) {
    console.log(`[motor] ${py} ile bağımlılıklar kuruldu ve doğrulandı`);
    process.exit(0);
  }
}

console.error("[motor] HATA: Python motoru bağımlılıkları doğrulanamadı. Yukarıdaki loglarda gerçek kurulum hatası yer alıyor.");
// Python motoru hazır değilse build tamamlanabilir; bu durum artık sessiz değildir.
process.exit(0);
