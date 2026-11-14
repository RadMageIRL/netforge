import './styles/main.css';
import { createCatalog } from './app/catalog';
import { setupOffline } from './app/offline';
import { VERSION_LABEL } from './app/pages';
import { browserStorage, Prefs } from './app/prefs';
import { startShell } from './app/shell';
import { byId } from './ui/dom';
import { icon } from './ui/icons';

byId('brand-version').textContent = VERSION_LABEL;
byId('brand-mark').appendChild(icon('logo', 'brand-icon'));
startShell(createCatalog(), new Prefs(browserStorage()));
setupOffline();
