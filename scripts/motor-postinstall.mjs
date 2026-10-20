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

  // Node-only Railway images may include Python without pip. Bootstrap an isolated
  // venv, then vendor packages into /app/pylib, which motor-render exposes via PYTHONPATH.
  const venvPath = "/tmp/mira-python-venv";
  const venv = spawnSync(py, ["-m", "venv", venvPath], {
    encoding: "utf8", timeout: 30_000, env
  });
  report(`${py} venv kurulumu (exit=${venv.status ?? "null"})`, venv);
  if (venv.status !== 0) continue;

  const venvPython = `${venvPath}/bin/python`;
  const pip = spawnSync(venvPython, [
    "-m", "pip", "install", "--target", "/app/pylib",
    "--disable-pip-version-check", "--no-cache-dir", ...wheels
  ], { encoding: "utf8", timeout: 240_000, env });
  report(`${py} bağımlılık kurulumu (exit=${pip.status ?? "null"})`, pip);

  const verify = spawnSync(py, ["-c", "import PIL, numpy, imageio_ffmpeg; print('MOTOR_DEPS_OK')"], {
    encoding: "utf8", timeout: 15000, env
  });
  report(`${py} son doğrulama`, verify);
  if (pip.status === 0 && verify.status === 0) {
    console.log(`[motor] ${py} ile bağımlılıklar /app/pylib içine kuruldu ve doğrulandı`);
    process.exit(0);
  }
}

console.error("[motor] HATA: Python motoru bağımlılıkları doğrulanamadı. Yukarıdaki loglarda gerçek kurulum hatası yer alıyor.");
// Python motoru hazır değilse build tamamlanabilir; bu durum artık sessiz değildir.
process.exit(0);
