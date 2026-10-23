'use client';

import KartalTaskManager from '@/components/KartalTaskManager';

export default function PanelPage() {
  return <KartalTaskManager onSwitchToOrb={() => { window.location.href = '/'; }} />;
}
