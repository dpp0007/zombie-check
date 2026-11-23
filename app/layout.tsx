import "./globals.css";
import { Fraunces, Inter } from "next/font/google";

const serif = Fraunces({ subsets: ["latin"], variable: "--serif", axes: ["opsz"], style: ["normal", "italic"] });
const sans = Inter({ subsets: ["latin"], variable: "--sans" });

export const metadata = { title: "Zombie Check", description: "Is anyone still home? Live-page verdicts for every row of your list." };
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
