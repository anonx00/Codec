"use client";

import React, { useState } from 'react';

export default function CallDashboard() {
    const [formData, setFormData] = useState({
        phoneNumber: '',
        restaurantName: '',
        time: '',
        partySize: '2'
    });
    const [status, setStatus] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setStatus('Initiating call...');

        const reservationDetails = `Time: ${formData.time}, Party of ${formData.partySize}`;

        // In a real setup, point this to your actual backend URL (or use a proxy)
        // For local dev with separate ports, ensure Backend has CORS enabled.
        const BACKEND_URL = 'http://localhost:8080/make-call';

        try {
            const res = await fetch(BACKEND_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phoneNumber: formData.phoneNumber,
                    restaurantName: formData.restaurantName,
                    reservationDetails
                })
            });

            const data = await res.json();

            if (res.ok) {
                setStatus(`Call Started! SID: ${data.callSid}`);
            } else {
                setStatus(`Error: ${data.error}`);
            }
        } catch (err) {
            console.error(err);
            setStatus('Failed to connect to backend.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-md mx-auto mt-10 p-6 bg-white rounded-xl shadow-md border border-gray-200">
            <h2 className="text-2xl font-bold mb-6 text-gray-800">🍽️ AI Reservation Caller</h2>

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700">Restaurant Name</label>
                    <input
                        type="text"
                        required
                        className="mt-1 w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                        placeholder="e.g. Dorsia"
                        value={formData.restaurantName}
                        onChange={(e) => setFormData({ ...formData, restaurantName: e.target.value })}
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium text-gray-700">Phone Number (E.164)</label>
                    <input
                        type="tel"
                        required
                        className="mt-1 w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                        placeholder="+14155551234"
                        value={formData.phoneNumber}
                        onChange={(e) => setFormData({ ...formData, phoneNumber: e.target.value })}
                    />
                    <p className="text-xs text-gray-500 mt-1">Must be a verified number in Twilio Trial.</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Time/Date</label>
                        <input
                            type="text"
                            required
                            className="mt-1 w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                            placeholder="Friday 7pm"
                            value={formData.time}
                            onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Party Size</label>
                        <input
                            type="number"
                            required
                            min="1"
                            className="mt-1 w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                            value={formData.partySize}
                            onChange={(e) => setFormData({ ...formData, partySize: e.target.value })}
                        />
                    </div>
                </div>

                <button
                    type="submit"
                    disabled={loading}
                    className={`w-full py-3 px-4 rounded-lg text-white font-bold transition-colors ${loading
                            ? 'bg-gray-400 cursor-not-allowed'
                            : 'bg-blue-600 hover:bg-blue-700 shadow-lg'
                        }`}
                >
                    {loading ? 'Calling...' : '📞 Call Now'}
                </button>
            </form>

            {status && (
                <div className={`mt-4 p-3 rounded-lg text-sm text-center ${status.includes('Error') || status.includes('Failed')
                        ? 'bg-red-100 text-red-700'
                        : 'bg-green-100 text-green-700'
                    }`}>
                    {status}
                </div>
            )}
        </div>
    );
}
