import Chat from "./chat";
import Head from "next/head";

export const metadata = {
  title: "GPT-4o Insight",
  description: "GPT-4o Insight leverages the power of GPT-4o to provide real-time insights and analysis of video content. Whether you're looking to understand complex scenes or get answers to specific questions about the video, GPT-4o Insight delivers accurate and detailed interpretations directly to you.",
};

export default function Page() {
  return (
    <>
      <Head>
        <title>{metadata.title}</title>
        <meta name="description" content={metadata.description} />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <Chat />
    </>
  );
}
