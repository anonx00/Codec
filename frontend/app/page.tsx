import CallDashboard from '../components/CallDashboard';

export default function Home() {
    return (
        <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
            <div className="w-full max-w-2xl">
                <div className="text-center mb-10">
                    <h1 className="text-4xl font-extrabold text-gray-900 mb-2">Agentic AI Caller Prototype</h1>
                    <p className="text-lg text-gray-600">Connect to your Node.js + Twilio backend to test real-time voice reservation agents.</p>
                </div>

                <CallDashboard />

                <div className="mt-10 text-center text-sm text-gray-500">
                    <p>Status Check: Ensure your Backend is running on port 8080 and Ngrok is active.</p>
                </div>
            </div>
        </main>
    );
}
