/** Keep the last authorized snapshot visible while a transient read recovers. */
export function LiveStatus({ resource }: { resource: { refreshError?: string } }) {
  return resource.refreshError ? <p className="muted small" role="status">Updates delayed. Showing the last loaded data. {resource.refreshError}</p> : null;
}
