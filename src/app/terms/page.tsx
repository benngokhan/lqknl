import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | AI Mira",
  description: "Terms governing use of the AI Mira service.",
};

const sections = [
  {
    title: "1. Eligibility and Accounts",
    body: "You must provide accurate information when creating or using an account and keep your login credentials confidential. You are responsible for activity performed through your account. Do not share credentials with unauthorized people or attempt to access another person’s account.",
  },
  {
    title: "2. Service Description",
    body: "AI Mira provides AI-assisted tools for supported YouTube-related tasks. Available features may include viewing channel or video information and performing supported management actions. Features may change, be limited, or become unavailable from time to time.",
  },
  {
    title: "3. YouTube and Google Services",
    body: "Use of YouTube-related features is also subject to applicable Google and YouTube terms, policies, and developer policies. When a feature requires Google authorization, you must complete the applicable authorization flow and grant only the permissions needed for that feature. You can manage or revoke access through your Google Account settings. AI Mira does not represent or imply endorsement by Google or YouTube.",
  },
  {
    title: "4. Acceptable Use",
    body: "You agree not to use the Service to violate laws, infringe intellectual property or privacy rights, circumvent security controls, interfere with the Service, access data without authorization, spam users, or perform actions that violate YouTube policies. You must ensure you have the necessary rights and permissions for content and accounts you manage.",
  },
  {
    title: "5. AI-Generated Outputs and User Responsibility",
    body: "AI-generated suggestions may be incomplete or inaccurate. You are responsible for reviewing titles, descriptions, metadata, and other proposed actions before applying them, and for confirming that actions taken through the Service reflect your intent and comply with applicable rules.",
  },
  {
    title: "6. Availability and Changes",
    body: "The Service is provided on an evolving basis. We may update, suspend, or discontinue features, temporarily restrict access for maintenance or security, or make changes needed to comply with applicable requirements. We do not guarantee uninterrupted or error-free operation.",
  },
  {
    title: "7. Privacy",
    body: "The Service’s handling of personal information is described in our Privacy Policy.",
  },
  {
    title: "8. Disclaimer",
    body: "To the extent permitted by law, the Service is provided “as is” and “as available,” without warranties of any kind, whether express or implied. Nothing in these Terms excludes rights or protections that cannot lawfully be excluded under applicable law.",
  },
  {
    title: "9. Limitation of Liability",
    body: "To the extent permitted by applicable law, AI Mira will not be liable for indirect, incidental, special, consequential, or punitive damages, or for loss of data, revenue, or profits arising from use of the Service. Nothing in these Terms limits liability where such limitation is prohibited by law.",
  },
  {
    title: "10. Changes to These Terms",
    body: "We may revise these Terms from time to time. The updated version will be made available with a revised effective date. Continued use of the Service after updated Terms take effect constitutes acceptance of the revised Terms, where permitted by law.",
  },
  {
    title: "11. Contact",
    body: "For questions about these Terms or the Service, use the contact method provided on the AI Mira website or contact the service operator through the channel where the Service was made available.",
  },
];

export default function TermsPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12 text-white">
      <a href="/" className="text-sm text-violet-300 underline">AI Mira home page</a>
      <h1 className="mt-6 text-3xl font-bold">Terms of Service</h1>
      <p className="mt-3 text-sm text-slate-400">Effective date: October 18, 2026</p>
      <p className="mt-6 text-slate-200 leading-7">
        These Terms of Service (“Terms”) govern your access to and use of AI Mira (the “Service”),
        an AI-assisted application that helps users interact with supported YouTube channel and
        video management features. By accessing or using the Service, you agree to these Terms.
        If you do not agree, do not use the Service.
      </p>
      {sections.map((section) => (
        <section key={section.title} className="mt-7">
          <h2 className="text-xl font-semibold">{section.title}</h2>
          <p className="mt-2 leading-7 text-slate-200">{section.body}</p>
          {section.title === "7. Privacy" && (
            <p className="mt-2 leading-7">
              <a href="/privacy" className="text-violet-300 underline">Read the AI Mira Privacy Policy</a>.
            </p>
          )}
        </section>
      ))}
      <p className="mt-10 text-sm text-slate-400">
        This document is a general template, not legal advice. Before relying on it, verify that
        it accurately describes the Service, its operator, contact method, and applicable law.
      </p>
    </main>
  );
}
