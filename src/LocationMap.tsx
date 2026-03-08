import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";

// Fix default marker icon in Vite (Leaflet needs explicit icon URLs)
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

interface LocationMapProps {
  lat: number;
  lon: number;
  locationLabel: string;
  valid: boolean;
}

export default function LocationMap({ lat, lon, locationLabel, valid }: LocationMapProps) {
  if (!valid) {
    return (
      <div className="flex h-[200px] w-full min-w-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-center text-sm text-slate-500 sm:h-[220px]">
        Enter valid coordinates to preview map.
      </div>
    );
  }

  return (
    <div className="h-[200px] w-full min-w-0 overflow-hidden rounded-md border border-slate-200 sm:h-[220px]">
      <MapContainer
        center={[lat, lon]}
        zoom={10}
        scrollWheelZoom={false}
        className="h-full w-full"
        key={`${lat}-${lon}`}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={[lat, lon]}>
          <Popup>
            {locationLabel}
            <br />
            <span className="text-slate-500">({lat.toFixed(4)}, {lon.toFixed(4)})</span>
          </Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}
