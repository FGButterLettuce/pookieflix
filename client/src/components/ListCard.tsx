import { Link } from 'react-router-dom';

export interface ListCardProps {
  id: number;
  name: string;
  itemCount: number;
  doneCount: number;
}

export function ListCard({ id, name, itemCount, doneCount }: ListCardProps) {
  const pct = itemCount > 0 ? Math.round((doneCount / itemCount) * 100) : 0;
  return (
    <Link to={`/marathons/${id}`} className="list-card">
      <div className="list-card-name">{name}</div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
      <div className="list-card-progress">{doneCount}/{itemCount} done</div>
    </Link>
  );
}
