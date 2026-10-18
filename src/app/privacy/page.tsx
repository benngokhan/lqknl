import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gizlilik Politikası | AI Mira",
  description: "AI Mira hizmetinin gizlilik politikası ve YouTube API verilerinin kullanımı.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12 text-white">
      <Link href="/" className="text-sm text-violet-300 underline">AI Mira ana sayfası</Link>
      <h1 className="mt-6 text-3xl font-bold">Gizlilik Politikası</h1>
      <p className="mt-2 text-sm text-white/60">Son güncelleme: 18 Ekim 2026</p>

      <div className="mt-8 space-y-6 leading-7 text-white/85">
        <section>
          <h2 className="text-xl font-semibold text-white">1. Kapsam</h2>
          <p>Bu politika, AI Mira uygulamasının kullanım sırasında işleyebileceği bilgileri ve YouTube API Hizmetleriyle nasıl etkileşim kurduğunu açıklar. AI Mira, Bilgi Dozu YouTube kanalının yönetimine yardımcı olmak için kullanılan bir yazılım uygulamasıdır.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">2. İşlenen bilgiler</h2>
          <p>Uygulama, kullanıcının başlattığı işlevlere bağlı olarak uygulama giriş bilgilerini ve teknik kayıtları; YouTube kanalına ait kanal adı, video kimlikleri, başlıklar, açıklamalar, etiketler ve yayın/gizlilik durumu gibi bilgileri işleyebilir. YouTube hesabı bağlandığında Google OAuth üzerinden verilen izinler kapsamında erişim belirteçleri ve yetkilendirme bilgileri de işlenebilir.</p>
          <p>Uygulamanın kullandığı özelliklere göre kullanıcı tarafından sağlanan komutlar, dosya veya içerik bilgileri de talep edilen işlemi yerine getirmek için işlenebilir.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">3. Kullanım amaçları</h2>
          <p>Bilgiler; kullanıcının talep ettiği kanal ve video bilgilerini görüntülemek, video yükleme ve metadata yönetimi işlemlerini yürütmek, yetkilendirmeyi sürdürmek, hataları teşhis etmek ve uygulamanın güvenliğini sağlamak amacıyla kullanılır.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">4. YouTube API Hizmetleri</h2>
          <p>AI Mira, YouTube API Hizmetleri&apos;ni kullanabilir. YouTube API üzerinden alınan verilerin kullanımı ve aktarımı, Google API Hizmetleri Kullanıcı Verileri Politikası ve YouTube Hizmet Şartları dahil ilgili koşullara tabidir. Kullanıcı, Google güvenlik ayarlarından AI Mira&apos;nın Google hesabına erişim iznini istediği zaman inceleyebilir veya kaldırabilir: <a className="text-violet-300 underline" href="https://myaccount.google.com/permissions">Google Hesabı izinleri</a>.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">5. Paylaşım ve satış</h2>
          <p>Kişisel bilgiler satılmaz. Bilgiler, yalnızca kullanıcının talep ettiği işlevi sunmak için gerekli olan hizmet sağlayıcılarla veya yürürlükteki hukukun gerektirdiği durumlarda paylaşılabilir. YouTube API verileri, ilgili Google/YouTube politikalarının izin verdiği şekilde işlenir.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">6. Saklama ve güvenlik</h2>
          <p>Bilgiler, talep edilen işlevi sağlamak, yetkilendirmeyi sürdürmek, güvenlik ve hata ayıklama ihtiyaçlarını karşılamak için gerekli olduğu süre boyunca saklanabilir. Erişimi korumak için uygun teknik ve idari önlemler uygulanmaya çalışılır; internet üzerinden hiçbir aktarım veya depolama yöntemi mutlak güvenlik garantisi vermez.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">7. Kullanıcının tercihleri</h2>
          <p>Kullanıcı, Google Hesabı izinleri sayfasından AI Mira&apos;nın Google/YouTube erişimini kaldırabilir. Erişim kaldırıldığında YouTube hesabına bağlı özellikler yeniden yetkilendirme yapılana kadar çalışmayabilir. Kişisel bilgiyle ilgili bir talep için uygulama yöneticisiyle AI Mira&apos;nın işletim kanalı üzerinden iletişim kurulmalıdır.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">8. Çocukların gizliliği</h2>
          <p>AI Mira, çocuklara yönelik bir hizmet olarak tasarlanmamıştır. Bilerek çocuklardan kişisel bilgi toplamayı amaçlamaz.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">9. Politika değişiklikleri</h2>
          <p>Bu politika güncellenebilir. Güncel sürüm bu sayfada yayımlanır ve güncelleme tarihi değiştirilir.</p>
        </section>
      </div>
    </main>
  );
}
