'use client';

import { useEffect } from 'react';
import { db } from '@/lib/db';
import { resignAllReceipts } from '@/lib/receipt';
import { DESTINATION } from '@/lib/egress';

const FLAG = 'airgap.receipts.resigned.v2';

/**
 * One-time migration: the demo database was written before the destination
 * label changed to "Google (US servers)". Receipts are re-signed in chain order
 * so old test receipts stay verifiable.
 */
export function ReceiptMigration() {
  useEffect(() => {
    (async () => {
      if (localStorage.getItem(FLAG)) return;
      const total = await db.receipts.count();
      if (total === 0) {
        localStorage.setItem(FLAG, '1');
        return;
      }
      const changed = await resignAllReceipts(DESTINATION);
      localStorage.setItem(FLAG, '1');
      console.info(`[migrate] re-signed ${changed} of ${total} receipts to "${DESTINATION}"`);
    })().catch((e) => console.warn('[migrate] re-sign failed:', (e as Error).message));
  }, []);

  return null;
}
