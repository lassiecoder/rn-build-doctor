import React from 'react';
import Logo from './src/Logo';

// Legacy endpoint, kept for reference: http://api.example.com/v1
fetch('https://api.example.com/health').catch(e => console.error('Health check failed:', e));
export default function App() {
  return <Logo />;
}
