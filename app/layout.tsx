import type { Metadata } from "next";
import { Exo, Lato } from "next/font/google";
import "./globals.css";

const exo = Exo({
  variable: "--font-exo",
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
  display: "swap",
});

const lato = Lato({
  variable: "--font-lato",
  subsets: ["latin"],
  weight: ["300", "400", "700", "900"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ark Media — Transcript Assistant",
  description: "Ask questions about Ark Media podcast episodes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${exo.variable} ${lato.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Intentionally synchronous: this script reads the saved theme (or OS
          preference) and applies a class to <html> before first paint, so we
          don't flash the wrong theme. `next/script` with `beforeInteractive`
          only emits a preload in App Router and doesn't run before paint, and
          `dangerouslySetInnerHTML` is the other canonical alternative. A plain
          <script src> is the most robust here — the eslint rule guards against
          accidental blocking 3rd-party scripts, which this is not.
        */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      <body className="relative min-h-full">
        <div className="ark-backdrop" aria-hidden />
        <div className="relative z-10 flex min-h-full flex-col">{children}</div>
      </body>
    </html>
  );
}
