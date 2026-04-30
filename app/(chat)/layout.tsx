import { ChatSidebar } from '@/components/ChatSidebar';
import { DeletionGate } from '@/components/DeletionGate';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full" style={{ fontFamily: 'var(--font-sans)' }}>
      <ChatSidebar />
      <DeletionGate>{children}</DeletionGate>
    </div>
  );
}
