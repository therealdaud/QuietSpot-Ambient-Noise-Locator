import { useState, useCallback } from 'react';
import { GoogleMap, useJsApiLoader, Marker, InfoWindow } from '@react-google-maps/api';

const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' };
const DEFAULT_CENTER = { lat: 27.994, lng: -81.760 }; // Central Florida fallback
const DEFAULT_ZOOM = 14;
const MAP_OPTIONS = {
  mapTypeControl: false,
  streetViewControl: false,
  fullscreenControl: false,
  zoomControlOptions: { position: 3 }, // RIGHT_TOP
};

function noiseColor(avg) {
  if (avg < 50) return '#22c55e';
  if (avg < 65) return '#eab308';
  if (avg < 80) return '#f97316';
  return '#ef4444';
}

function noiseLabel(avg) {
  if (avg < 50) return 'Very Quiet';
  if (avg < 65) return 'Moderate';
  if (avg < 80) return 'Loud';
  return 'Very Loud';
}

function makeMarkerIcon(avg) {
  const color = noiseColor(avg);
  const label = Math.round(avg).toString();
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="42" height="42">
      <circle cx="21" cy="21" r="18" fill="${color}" stroke="white" stroke-width="2.5" opacity="0.92"/>
      <text x="21" y="26" text-anchor="middle" font-size="11" font-weight="700"
            fill="white" font-family="Arial, sans-serif">${label}</text>
    </svg>`.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export default function MapView({ spots, userLocation, onMarkerClick, apiKey }) {
  const { isLoaded, loadError } = useJsApiLoader({ googleMapsApiKey: apiKey });
  const [hoveredSpot, setHoveredSpot] = useState(null);
  const [map, setMap] = useState(null);

  const onLoad = useCallback(m => setMap(m), []);
  const onUnmount = useCallback(() => setMap(null), []);

  // Re-center when user location arrives
  if (map && userLocation) {
    map.panTo(userLocation);
  }

  if (loadError) {
    return (
      <div className="map-message map-error">
        Failed to load Google Maps. Check your API key.
      </div>
    );
  }

  if (!isLoaded) {
    return <div className="map-message">Loading map…</div>;
  }

  const center = userLocation || DEFAULT_CENTER;

  return (
    <GoogleMap
      mapContainerStyle={MAP_CONTAINER_STYLE}
      center={center}
      zoom={DEFAULT_ZOOM}
      options={MAP_OPTIONS}
      onLoad={onLoad}
      onUnmount={onUnmount}
    >
      {/* User location pulse dot */}
      {userLocation && (
        <Marker
          position={userLocation}
          icon={{
            url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
                <circle cx="10" cy="10" r="8" fill="#3b82f6" stroke="white" stroke-width="2.5"/>
              </svg>`)}`,
            anchor: { x: 10, y: 10 },
          }}
          title="Your location"
          zIndex={999}
        />
      )}

      {/* Noise spots */}
      {spots.map(spot => (
        <Marker
          key={spot.key}
          position={{ lat: spot.lat, lng: spot.lng }}
          icon={makeMarkerIcon(spot.avg)}
          onClick={() => {
            setHoveredSpot(null);
            onMarkerClick(spot);
          }}
          onMouseOver={() => setHoveredSpot(spot)}
          onMouseOut={() => setHoveredSpot(null)}
          zIndex={1}
        />
      ))}

      {/* Hover tooltip */}
      {hoveredSpot && (
        <InfoWindow
          position={{ lat: hoveredSpot.lat, lng: hoveredSpot.lng }}
          options={{ disableAutoPan: true, pixelOffset: { width: 0, height: -28 } }}
          onCloseClick={() => setHoveredSpot(null)}
        >
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <strong style={{ color: noiseColor(hoveredSpot.avg) }}>
              {noiseLabel(hoveredSpot.avg)}
            </strong>
            <br />
            {hoveredSpot.avg.toFixed(1)} dBA avg &bull; {hoveredSpot.n} reading{hoveredSpot.n !== 1 ? 's' : ''}
            <br />
            <span style={{ color: '#6b7280', fontSize: 11 }}>Click for details</span>
          </div>
        </InfoWindow>
      )}
    </GoogleMap>
  );
}
