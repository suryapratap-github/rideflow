import Dashboard from '../../../components/dashboard';
export default function Workspace({params}:{params:{workspace:string,section?:string[]}}){return <Dashboard workspace={params.workspace} section={params.section?.[0]||'overview'}/>}
