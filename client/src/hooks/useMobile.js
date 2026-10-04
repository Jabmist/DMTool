import { useState, useEffect } from 'react';

export function useMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  useEffect(() => {
    let timer;
    const fn = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIsMobile(window.innerWidth <= 768), 150);
    };
    window.addEventListener('resize', fn);
    return () => { window.removeEventListener('resize', fn); clearTimeout(timer); };
  }, []);
  return isMobile;
}
