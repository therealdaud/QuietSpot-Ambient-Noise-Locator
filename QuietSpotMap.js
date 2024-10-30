import React, { useState, useEffect } from 'react';
import { View, TextInput, Button, Modal, Text, Alert, Platform, PermissionsAndroid } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import Geolocation from '@react-native-community/geolocation';
import axios from 'axios';
import NoiseMeter from './NoiseMeter';  // Import the NoiseMeter component

const QuietSpotMap = () => {
    const [region, setRegion] = useState(null);  // Start with no initial region (null)
    const [hasLocationPermission, setHasLocationPermission] = useState(false);
    const [hasMicrophonePermission, setHasMicrophonePermission] = useState(false);  // Microphone permission state
    const [markers, setMarkers] = useState([]);  // Array of markers
    const [searchQuery, setSearchQuery] = useState('');  // Search bar input
    const [modalVisible, setModalVisible] = useState(false);  // For adding/editing markers
    const [newMarker, setNewMarker] = useState(null);  // Holds the new marker's location
    const [newMarkerTitle, setNewMarkerTitle] = useState('');  // Holds title for the new marker
    const [newMarkerDescription, setNewMarkerDescription] = useState('');  // Holds description for the new marker
    const [editingMarkerIndex, setEditingMarkerIndex] = useState(null);  // Track which marker is being edited

    // Request location permission for Android
    const requestLocationPermission = async () => {
        try {
            if (Platform.OS === 'android') {
                const granted = await PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
                    {
                        title: 'Location Access Required',
                        message: 'This app needs to access your location to show nearby quiet spots.',
                        buttonNeutral: 'Ask Me Later',
                        buttonNegative: 'Cancel',
                        buttonPositive: 'OK',
                    }
                );
                if (granted === PermissionsAndroid.RESULTS.GRANTED) {
                    setHasLocationPermission(true);
                } else {
                    Alert.alert('Permission Denied', 'Location access is required for the app to function.');
                }
            } else {
                setHasLocationPermission(true);  // iOS handles permissions automatically
            }
        } catch (err) {
            console.warn(err);
        }
    };

    // Request microphone permission for noise level detection
    const requestMicrophonePermission = async () => {
        try {
            if (Platform.OS === 'android') {
                const granted = await PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
                    {
                        title: 'Microphone Access Required',
                        message: 'This app needs to access your microphone to monitor noise levels.',
                        buttonNeutral: 'Ask Me Later',
                        buttonNegative: 'Cancel',
                        buttonPositive: 'OK',
                    }
                );
                if (granted === PermissionsAndroid.RESULTS.GRANTED) {
                    setHasMicrophonePermission(true);
                } else {
                    Alert.alert('Permission Denied', 'Microphone access is required for the app to monitor noise.');
                }
            } else {
                setHasMicrophonePermission(true);  // iOS handles permissions automatically
            }
        } catch (err) {
            console.warn(err);
        }
    };

    // Request permissions on component mount
    useEffect(() => {
        requestLocationPermission();
        requestMicrophonePermission();  // Request microphone permission as well
    }, []);

    // Get user's current location and update the map region
    useEffect(() => {
        if (hasLocationPermission) {
            Geolocation.getCurrentPosition(
                (position) => {
                    const { latitude, longitude } = position.coords;
                    setRegion({
                        latitude,
                        longitude,
                        latitudeDelta: 0.01,  // Zoom into the location
                        longitudeDelta: 0.01,
                    });
                },
                (error) => console.log(error),
                { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 }
            );
        }
    }, [hasLocationPermission]);

    // Function to search for a location (using Google Maps API)
    const handleSearch = async () => {
        if (searchQuery.trim() === '') return;
        try {
            const response = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json`, {
                params: {
                    address: searchQuery,
                    key: 'AIzaSyBlsotqsCQWA3GollxCM94QyC2pP7m84LI',  // Replace with your Google API key
                },
            });
            const location = response.data.results[0].geometry.location;
            setRegion({
                latitude: location.lat,
                longitude: location.lng,
                latitudeDelta: 0.01,
                longitudeDelta: 0.01,
            });
        } catch (error) {
            console.error('Error searching location:', error);
        }
    };

    // Function to add marker on long press
    const handleLongPress = (event) => {
        const { latitude, longitude } = event.nativeEvent.coordinate;
        setNewMarker({ latitude, longitude });
        setModalVisible(true);  // Show the modal to add title/description
    };

    // Function to save new marker with title and description
    const handleSaveMarker = () => {
        if (editingMarkerIndex !== null) {
            // If editing a marker, update the marker in the list
            const updatedMarkers = markers.map((marker, index) => {
                if (index === editingMarkerIndex) {
                    return { ...marker, title: newMarkerTitle, description: newMarkerDescription };
                }
                return marker;
            });
            setMarkers(updatedMarkers);
        } else {
            // If adding a new marker, add it to the list
            setMarkers([...markers, { ...newMarker, title: newMarkerTitle, description: newMarkerDescription }]);
        }

        setNewMarker(null);
        setNewMarkerTitle('');
        setNewMarkerDescription('');
        setModalVisible(false);  // Close the modal
        setEditingMarkerIndex(null);  // Reset editing marker index
    };

    // Function to delete a marker
    const handleDeleteMarker = (index) => {
        setMarkers(markers.filter((_, i) => i !== index));
    };

    // Function to edit a marker
    const handleEditMarker = (marker, index) => {
        setNewMarker(marker);
        setNewMarkerTitle(marker.title);
        setNewMarkerDescription(marker.description);
        setEditingMarkerIndex(index);
        setModalVisible(true);
    };

    if (!region) {
        // While the location is being fetched, show a loading view or null
        return <View style={{ flex: 1 }} />;
    }

    return (
        <View style={{ flex: 1 }}>
            {/* Search bar */}
            <View style={{ flexDirection: 'row', margin: 10 }}>
                <TextInput
                    placeholder="Search for location..."
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    style={{ flex: 1, borderWidth: 1, padding: 10, marginRight: 10 }}
                />
                <Button title="Search" onPress={handleSearch} />
            </View>

            <MapView
                style={{ flex: 1 }}
                region={region}  // Use the current region for centering the map
                onRegionChangeComplete={(newRegion) => setRegion(newRegion)}  // Update region on map move
                showsUserLocation={true}  // Show user's current location
                onLongPress={handleLongPress}  // Long press to add marker
            >
                {/* Render all markers */}
                {markers.map((marker, index) => (
                    <Marker
                        key={index}
                        coordinate={{ latitude: marker.latitude, longitude: marker.longitude }}
                        title={marker.title}
                        description={marker.description}
                        onCalloutPress={() => handleEditMarker(marker, index)}  // Edit marker on callout press
                        onLongPress={() => handleDeleteMarker(index)}  // Long press to delete marker
                    />
                ))}
            </MapView>

            {/* Modal to add title and description for a new marker */}
            <Modal visible={modalVisible} animationType="slide" transparent={true}>
                <View style={{
                    flex: 1, justifyContent: 'center', alignItems: 'center',
                    backgroundColor: 'rgba(0, 0, 0, 0.5)'
                }}>
                    <View style={{
                        width: 300, backgroundColor: 'white', padding: 20,
                        borderRadius: 10, shadowColor: '#000', shadowOpacity: 0.5
                    }}>
                        <Text>Enter Marker Title:</Text>
                        <TextInput
                            value={newMarkerTitle}
                            onChangeText={setNewMarkerTitle}
                            placeholder="Marker Title"
                            style={{ borderWidth: 1, padding: 8, marginVertical: 10 }}
                        />
                        <Text>Enter Marker Description:</Text>
                        <TextInput
                            value={newMarkerDescription}
                            onChangeText={setNewMarkerDescription}
                            placeholder="Marker Description"
                            style={{ borderWidth: 1, padding: 8, marginVertical: 10 }}
                        />
                        <Button title="Save Marker" onPress={handleSaveMarker} />
                        <Button title="Cancel" onPress={() => setModalVisible(false)} />
                    </View>
                </View>
            </Modal>

            {/* Noise Meter: Positioned at theHere is the rest of the updated code, continuing from where it was cut off:

```javascript
            {/* Noise Meter: Positioned at the bottom-right corner */}
            <View style={{ position: 'absolute', bottom: 10, right: 10 }}>
                <NoiseMeter />
            </View>
        </View>
    );
};

export default QuietSpotMap;





