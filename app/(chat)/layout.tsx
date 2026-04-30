import { ChatSidebar } from '@/components/ChatSidebar';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full" style={{ fontFamily: 'var(--font-sans)' }}>
      <ChatSidebar />
      {children}
    </div>
  );
}
