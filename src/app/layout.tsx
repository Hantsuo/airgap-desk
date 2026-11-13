import type { Metadata } from 'next';
import './globals.css';
import { I18nProvider } from '@/lib/i18n';
import { ReceiptMigration } from '@/components/ReceiptMigration';
import { ServiceWorker } from '@/components/ServiceWorker';

export const metadata: Metadata = {
  title: 'Airgap Desk',
  description: 'Offline-first claims inspection desk. On-device extraction, signed egress receipts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          <ReceiptMigration />
          <ServiceWorker />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
