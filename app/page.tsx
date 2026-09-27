import Chat from "@/components/Chat";

export default function Home() {
  return (
    <main className="mx-auto flex h-screen max-w-5xl flex-col bg-white shadow-sm sm:border-x sm:border-stone-200">
      <Chat />
    </main>
  );
}
