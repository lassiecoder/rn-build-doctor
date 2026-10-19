import React from 'react';
import { StatusBar } from 'react-native';
import RootNavigator from './src/navigation/RootNavigator';

fetch('http://10.0.2.2:8099/api/health').then(r => console.log('health', r.status)).catch(e => console.error('Health check failed:', e));
function App(): React.JSX.Element {
  return <RootNavigator />;
}

export default App;
