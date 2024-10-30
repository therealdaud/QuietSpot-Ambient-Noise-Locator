import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import SoundLevel from 'react-native-sound-level';

const NoiseMeter = () => {
    useEffect(() => {
        SoundLevel.start();
        
        SoundLevel.onNewFrame = (data) => {
            console.log('Sound Level Info', data);
            // data.value will give you decibel level
        };

        // Stop sound level capture when component unmounts
        return () => {
            SoundLevel.stop();
        };
    }, []);

    return (
        <View>
            <Text>Monitoring Sound Level...</Text>
        </View>
    );
};

export default NoiseMeter;
 